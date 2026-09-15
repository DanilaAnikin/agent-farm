/**
 * Doručení (merge smyčka) — úkoly ve stavu `merging` dotáhne až do sloučeného PR.
 *
 * Proč: soudce u existujícího repa jen otevřel PR a úkol rovnou označil za hotový.
 * Nic pak průběžně neslučovalo — PR visely do nočního triage skriptu, nebo je
 * naslepo sloučil deploy skript. Závislé úkoly se přitom rozjely nad kódem, který
 * v hlavní větvi nebyl. Teď úkol čeká v `merging` a tahle smyčka:
 *
 *   1. načte PR; je-li `behind`, požádá GitHub o update-branch a počká na nové CI,
 *   2. vyhodnotí sdílenou přísnou bránu (evaluateMergeGate z @farm/core),
 *   3. projde → merge s parametrem `sha` (sloučí se PRÁVĚ otestovaný commit),
 *      úkol `merging → done`, pokus vítěz, odblokování závislých, postup přání,
 *   4. neprojde → úkol zůstane v `merging` a zapíše se (deduplikovaně) důvod;
 *      blokuje-li ho tentýž důvod přes 24 h, úkol se vrátí workerovi jako oprava
 *      na TÉŽE větvi (worker pokračuje z hlavy PR a oprava se pushne do stejného PR).
 *
 * PR farma NIKDY nezavírá.
 *
 * Smyčka NENÍ `pausable` (index.ts): merge nestojí tokeny a autonomní farma nemá
 * čekat na konec off-peaku. Respektuje jen vypínač majitele — čte ho jako první
 * věc a znovu těsně před samotným sloučením.
 */
import { getDb, getSql, tasks, attempts, reviews, projects, QUEUES, enqueue } from "@farm/db";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { evaluateMergeGate, taskMachine } from "@farm/core";
import type { MergeGateCheckRun, MergeGateResult } from "@farm/core";
import { logEvent } from "./events.js";
import type { LogEventInput } from "./events.js";
import { getSetting } from "./settings.js";
import { githubClientForProject, fetchPullHead, redactSecrets } from "./git.js";
import type { GithubRepoClient } from "./git.js";
import { enqueueReadyDependents, parkBlockedDependents } from "./dag.js";
import { deliverApprovedAttempt, reportWishProgress, maybeCompleteWish, maybeReplanStuckWish } from "./judge.js";
import type { TaskMessage } from "./types.js";

/** Jak dlouho smí úkol viset v `merging` na stejném důvodu, než se vrátí k opravě. */
const MERGE_STUCK_MS = Number(process.env.MERGE_STUCK_MS ?? 24 * 60 * 60_000);
/** Kolikrát smí merge smyčka vrátit úkol k opravě, než doručení vzdá. */
const MAX_MERGE_FIXES = Number(process.env.MAX_MERGE_FIXES ?? 3);
/** Kolik úkolů v `merging` zpracovat za jednu iteraci. */
const BATCH = 20;

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface ApprovedAttempt {
  id: string;
  branch: string;
  prNumber: number | null;
  headSha: string | null;
  status: string;
}

/** Jedna iterace merge smyčky. */
export async function runDeliveryOnce(): Promise<void> {
  // PRVNÍ věc: vypínač majitele. Záměrně jen `owner_pause`, ne isGlobalPaused —
  // `global_pause` zapíná off-peak a rozpočtový hlídač a merge nic neutrácí.
  if (await ownerPaused()) {
    const waiting = await getSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tasks WHERE status = 'merging'
    `;
    const n = waiting[0]?.n ?? 0;
    if (n > 0) {
      await logEventDeduped(
        {
          type: "delivery_paused_owner",
          level: "info",
          message: `Vypínač majitele je zapnutý — farma neslučuje žádné PR (čeká ${n}), dokud ho majitel nevypne.`,
          data: { waiting: n },
        },
        "owner_pause",
        6 * 60 * 60_000,
      );
    }
    return;
  }

  const rows = await getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.status, "merging"))
    .orderBy(asc(tasks.updatedAt))
    .limit(BATCH);

  // Po sloučení jednoho PR se ostatní PR téhož repa posunou za main — GitHub musí
  // přepočítat mergeable a CI. V jedné iteraci proto slučujeme nejvýš jeden PR na projekt.
  const mergedProjects = new Set<string>();
  for (const task of rows) {
    try {
      await deliverTask(task, mergedProjects);
    } catch (err) {
      const error = redactSecrets(String(err));
      console.error(`[delivery] úkol ${task.id} selhal:`, error);
      await logEventDeduped(
        {
          projectId: task.projectId,
          taskId: task.id,
          level: "warn",
          type: "pr_merge_blocked",
          message: "Doručovací krok selhal — farma ho zkusí znovu za minutu.",
          data: { error },
        },
        "delivery_error",
      ).catch(() => undefined);
    }
  }
}

async function ownerPaused(): Promise<boolean> {
  return Boolean(await getSetting<unknown>("owner_pause", false));
}

async function deliverTask(task: TaskRow, mergedProjects: Set<string>): Promise<void> {
  const projRows = await getDb().select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const project = projRows[0];
  if (!project) return;
  if (mergedProjects.has(project.id)) return;

  if (project.repoMode !== "existing") {
    // Do 'merging' se dnes dostane jen existující repo; nová repa merguje judge.
    await logEventDeduped(
      {
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "pr_merge_blocked",
        message: "Úkol čeká na sloučení, ale projekt nemá existující repo s PR — farma ho vrací workerovi.",
      },
      "not_existing_repo",
    );
    await requeueAsFix(task, project, null, "Projekt nemá PR, do kterého by šlo doručit.", "");
    return;
  }

  const attempt = await latestApprovedAttempt(task.id);
  if (!attempt) {
    await requeueAsFix(task, project, null, "Úkol čekal na sloučení bez schváleného pokusu.", "");
    return;
  }

  // Otevření PR při schválení selhalo → opakuje se JEN doručovací krok.
  if (!attempt.prNumber) {
    const res = await deliverApprovedAttempt(project, task, attempt.id, attempt.branch);
    if (!res.ok) {
      const { since } = await logEventDeduped(
        {
          projectId: project.id,
          taskId: task.id,
          level: "warn",
          type: "pr_merge_blocked",
          message: "PR se zatím nepodařilo otevřít — farma to zkouší znovu každou minutu.",
          data: { error: res.error },
        },
        "pr_open_failed",
      );
      await maybeStuck(task, project, attempt, since, "PR se nedaří otevřít.", res.error);
    }
    return;
  }

  let gh: GithubRepoClient;
  try {
    gh = await githubClientForProject(project.id);
  } catch (err) {
    await logEventDeduped(
      {
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "pr_merge_blocked",
        message: `GitHub není pro projekt dostupný (${redactSecrets(String(err))}) — farma to zkusí znovu.`,
      },
      "github_unavailable",
    );
    return;
  }
  const { octokit, owner, repo } = gh;
  const prNumber = attempt.prNumber;

  let pr: Awaited<ReturnType<typeof octokit.pulls.get>>["data"];
  try {
    pr = (await octokit.pulls.get({ owner, repo, pull_number: prNumber })).data;
  } catch (err) {
    if (httpStatus(err) === 404) {
      await requeueAsFix(task, project, attempt, `PR #${prNumber} na GitHubu neexistuje.`, "");
      return;
    }
    throw err;
  }

  // Sloučeno mimo smyčku (např. triage skript) — jen dotáhnout stav.
  if (pr.merged) {
    await completeMerged(task, project, attempt, prNumber, pr.head.sha, pr.merge_commit_sha ?? null);
    mergedProjects.add(project.id);
    return;
  }
  if (pr.state === "closed") {
    // PR zavřel někdo mimo farmu. Farma ho sama nikdy nezavírá; práci doručí znovu
    // (worker pokračuje z hlavy zavřeného PR a soudce otevře nový).
    await requeueAsFix(task, project, attempt, `PR #${prNumber} byl zavřen bez sloučení.`, "");
    return;
  }

  const headSha = pr.head.sha;

  // Hlava PR se pohnula od posouzeného commitu. Přijatelné jsou jen merge commity
  // z hlavní větve (update-branch) — cizí commity soudce neviděl.
  if (attempt.headSha && headSha !== attempt.headSha) {
    const onlyBaseMerges = await onlyMergeCommitsSince(gh, attempt.headSha, headSha);
    if (!onlyBaseMerges) {
      await requeueAsFix(
        task,
        project,
        attempt,
        `PR #${prNumber} obsahuje commity, které soudce neposoudil.`,
        "Zkontroluj nové commity v PR, ověř je a dokonči úkol na téže větvi.",
      );
      return;
    }
  }

  if (pr.mergeable_state === "behind") {
    try {
      await octokit.pulls.updateBranch({ owner, repo, pull_number: prNumber, expected_head_sha: headSha });
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        type: "pr_branch_updated",
        message: `PR #${prNumber} zaostával za hlavní větví — farma ho aktualizovala a čeká na nové CI.`,
        data: { prNumber, headSha },
      });
    } catch (err) {
      await logEventDeduped(
        {
          projectId: project.id,
          taskId: task.id,
          level: "warn",
          type: "pr_merge_blocked",
          message: `PR #${prNumber} nejde automaticky aktualizovat na hlavní větev (${httpStatus(err) ?? "chyba"}) — nejspíš konflikt.`,
          data: { prNumber, headSha },
        },
        "update_branch_failed",
      );
    }
    return;
  }

  // Podklady brány.
  const checkRunsRaw = (await octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 })).data.check_runs;
  const checkRuns: MergeGateCheckRun[] = checkRunsRaw.map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    headSha: c.head_sha,
  }));
  const combined = (await octokit.repos.getCombinedStatusForRef({ owner, repo, ref: headSha })).data;
  let repoHasWorkflows = true; // neznámo = předpokládej CI (čekat, ne slučovat naslepo)
  try {
    const wf = await octokit.actions.listRepoWorkflows({ owner, repo, per_page: 100 });
    repoHasWorkflows = wf.data.workflows.some((w) => w.state === "active");
  } catch {
    /* ponech true */
  }
  const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
  const changedFiles = files.filter((f) => f.status !== "removed").map((f) => f.filename);
  const addedLines = files.flatMap((f) =>
    (f.patch ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1)),
  );

  const gateInput = {
    headSha,
    checkRuns,
    combinedStatus: { state: combined.state, totalCount: combined.total_count, sha: combined.sha },
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    // latestApprovedAttempt vrací jen pokus s approve review v DB; posun hlavy
    // mimo merge commity z main už výše vrátil úkol k opravě.
    judgeApproved: true,
    changedFiles,
    addedLines,
    repoHasWorkflows,
    openedAt: pr.created_at,
  };
  // Vypínač se čte ZNOVU těsně před rozhodnutím — mohl se zapnout během dotazů.
  const gate = evaluateMergeGate({ ...gateInput, ownerPause: await ownerPaused() });

  if (gate.allow) {
    const merged = await mergePullRequest(gh, prNumber, headSha);
    if (merged.merged) {
      await completeMerged(task, project, attempt, prNumber, headSha, merged.mergeSha ?? null);
      mergedProjects.add(project.id);
      return;
    }
    const { since } = await logEventDeduped(
      {
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "pr_merge_blocked",
        message: `GitHub sloučení PR #${prNumber} odmítl: ${merged.message ?? "neznámý důvod"}`,
        data: { prNumber, headSha },
      },
      "merge_rejected",
    );
    await maybeStuck(task, project, attempt, since, `GitHub sloučení odmítl: ${merged.message ?? ""}`, "");
    return;
  }

  const { since } = await logEventDeduped(
    {
      projectId: project.id,
      taskId: task.id,
      level: gate.wait ? "info" : "warn",
      type: "pr_merge_blocked",
      message: gate.wait
        ? `PR #${prNumber} zatím nejde sloučit: ${gate.reason} Farma počká.`
        : `PR #${prNumber} nejde sloučit: ${gate.reason} Farma to zkouší dál; když to vydrží 24 h, vrátí úkol workerovi k opravě na téže větvi.`,
      data: { prNumber, headSha, reason: gate.reason, wait: gate.wait === true },
    },
    gate.code,
  );
  if (gate.code === "owner_pause") return;
  const detail = gate.code === "check_failed" ? await failingChecksDetail(gh, checkRunsRaw) : "";
  await maybeStuck(task, project, attempt, since, gate.reason ?? "brána neprošla", detail, gate);
}

/** Nejnovější pokus úkolu se schváleným review a větví. */
async function latestApprovedAttempt(taskId: string): Promise<ApprovedAttempt | null> {
  const rows = await getDb()
    .select({
      id: attempts.id,
      branch: attempts.branch,
      prNumber: attempts.prNumber,
      headSha: attempts.headSha,
      status: attempts.status,
    })
    .from(attempts)
    .innerJoin(reviews, eq(reviews.attemptId, attempts.id))
    .where(and(eq(attempts.taskId, taskId), eq(reviews.verdict, "approve"), isNotNull(attempts.branch)))
    .orderBy(desc(attempts.startedAt))
    .limit(1);
  const r = rows[0];
  if (!r || !r.branch) return null;
  return { ...r, branch: r.branch };
}

/** Přes 24 h stejný důvod → oprava na téže větvi. */
async function maybeStuck(
  task: TaskRow,
  project: ProjectRow,
  attempt: ApprovedAttempt,
  since: Date,
  reason: string,
  detail: string,
  gate?: MergeGateResult,
): Promise<void> {
  const now = Date.now();
  const inMerging = now - new Date(task.updatedAt).getTime();
  if (now - since.getTime() < MERGE_STUCK_MS || inMerging < MERGE_STUCK_MS) return;
  await requeueAsFix(task, project, attempt, reason, detail, gate);
}

/**
 * `merging → queued` s isFix: worker pokračuje z AKTUÁLNÍ hlavy PR (resumeRef) a
 * soudce pak opravu pushne do stejného PR. Po MAX_MERGE_FIXES kolech se doručení
 * vzdá (`merging → parked`, PR zůstává otevřený) a přání jde k přeplánování.
 */
async function requeueAsFix(
  task: TaskRow,
  project: ProjectRow,
  attempt: ApprovedAttempt | null,
  reason: string,
  detail: string,
  gate?: MergeGateResult,
): Promise<void> {
  const prNumber = attempt?.prNumber ?? null;
  const fixRows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events WHERE task_id = ${task.id} AND type = 'task_merge_fix'
  `;
  const fixes = fixRows[0]?.n ?? 0;

  if (fixes >= MAX_MERGE_FIXES) {
    taskMachine.assert("merging", "parked");
    const parked = await getDb()
      .update(tasks)
      .set({ status: "parked", parkReason: "judge_exhausted", parkedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "merging")))
      .returning({ id: tasks.id });
    if (parked.length === 0) return;
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      type: "task_parked",
      message: `Doručení úkolu „${task.title}" vzdáno po ${fixes} opravách${prNumber ? ` (PR #${prNumber} zůstává otevřený)` : ""}: ${reason} Farma přání přeplánuje.`,
      data: { reason, prNumber, parkReason: "judge_exhausted" },
    });
    await parkBlockedDependents(task.id, task.wishId, "delivery_exhausted");
    await maybeReplanStuckWish(task.wishId, project);
    return;
  }

  let resumeRef: string | undefined;
  if (prNumber) {
    resumeRef = await fetchPullHead(project.id, prNumber).catch(() => undefined);
  }
  if (!resumeRef && attempt?.headSha && /^[a-f0-9]{40}$/.test(attempt.headSha)) resumeRef = attempt.headSha;

  taskMachine.assert("merging", "queued");
  const moved = await getDb()
    .update(tasks)
    .set({ status: "queued" })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "merging")))
    .returning({ id: tasks.id });
  if (moved.length === 0) return;

  const note = [
    prNumber
      ? `Automatické sloučení PR #${prNumber} je zablokované: ${reason}`
      : `Doručení úkolu je zablokované: ${reason}`,
    detail ? `Podrobnosti:\n${detail.slice(0, 4000)}` : "",
    prNumber
      ? "Oprav to na TÉŽE větvi — pokračuješ z aktuální hlavy PR a farma změnu pushne do stejného PR. PR nezavírej, testy ani CI neoslabuj."
      : "Dokonči úkol znovu; testy ani CI neoslabuj.",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  const msg: TaskMessage = {
    taskId: task.id,
    projectId: project.id,
    wishId: task.wishId,
    kind: task.kind,
    isFix: true,
    note,
    ...(resumeRef ? { resumeRef } : {}),
  };
  await enqueue(QUEUES.tasks, msg);
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    level: "warn",
    type: "task_merge_fix",
    message: prNumber
      ? `PR #${prNumber} se nedaří sloučit (${reason}) — farma vrací úkol workerovi k opravě na téže větvi (kolo ${fixes + 1}/${MAX_MERGE_FIXES}).`
      : `Doručení se nedaří (${reason}) — farma vrací úkol workerovi (kolo ${fixes + 1}/${MAX_MERGE_FIXES}).`,
    data: { prNumber, code: gate?.code ?? null, resumeRef: resumeRef ?? null, round: fixes + 1 },
  });
}

/** Potvrzené sloučení: úkol done, pokus vítěz, závislí, postup a dokončení přání. */
async function completeMerged(
  task: TaskRow,
  project: ProjectRow,
  attempt: ApprovedAttempt,
  prNumber: number,
  sha: string,
  mergeSha: string | null,
): Promise<void> {
  taskMachine.assert("merging", "done");
  const done = await getDb()
    .update(tasks)
    .set({ status: "done" })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "merging")))
    .returning({ id: tasks.id });
  if (done.length === 0) return;

  // Pokus je 'succeeded' od schválení (judge.ts); starší data mohla nechat 'running'.
  await getDb()
    .update(attempts)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(and(eq(attempts.id, attempt.id), eq(attempts.status, "running")));
  await getDb().update(attempts).set({ isWinner: true }).where(eq(attempts.id, attempt.id));

  await logEvent({
    projectId: project.id,
    taskId: task.id,
    type: "pr_merged",
    message: `PR #${prNumber} sloučen do hlavní větve: ${task.title}`,
    data: { prNumber, sha, mergeSha },
  });
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    type: "task_done",
    message: `Task hotový: ${task.title}`,
    data: { prNumber },
  });
  // Až TEĎ je kód v hlavní větvi → odblokovat navazující práci a počítat postup.
  await enqueueReadyDependents(task.id, task.wishId);
  await reportWishProgress(task.wishId, project);
  await maybeCompleteWish(task.wishId, project);
}

/** Merge s `sha` (nikdy bez něj). Když repo nepovoluje merge commity, zkusí squash/rebase. */
async function mergePullRequest(
  gh: GithubRepoClient,
  prNumber: number,
  sha: string,
): Promise<{ merged: boolean; mergeSha?: string; message?: string }> {
  const methods: (undefined | "squash" | "rebase")[] = [undefined, "squash", "rebase"];
  for (const method of methods) {
    try {
      const res = await gh.octokit.pulls.merge({
        owner: gh.owner,
        repo: gh.repo,
        pull_number: prNumber,
        sha,
        ...(method ? { merge_method: method } : {}),
      });
      return { merged: res.data.merged, mergeSha: res.data.sha, message: res.data.message };
    } catch (err) {
      const status = httpStatus(err);
      const text = redactSecrets(String(err), gh.token);
      if (status === 405 && /not allowed/i.test(text)) continue;
      if (status === 409) return { merged: false, message: "hlava PR se mezitím změnila, brána se vyhodnotí znovu" };
      return { merged: false, message: text };
    }
  }
  return { merged: false, message: "repo nepovoluje žádný způsob sloučení, který farma umí" };
}

/** Obsahuje posun hlavy PR jen merge commity (update-branch z hlavní větve)? */
async function onlyMergeCommitsSince(gh: GithubRepoClient, base: string, head: string): Promise<boolean> {
  try {
    const cmp = await gh.octokit.repos.compareCommits({ owner: gh.owner, repo: gh.repo, base, head });
    if (cmp.data.status !== "ahead") return false;
    return cmp.data.commits.every((c) => (c.parents?.length ?? 0) > 1);
  } catch {
    return false;
  }
}

/** Jméno a konec logu padajících kroků CI — do poznámky workerovi. */
async function failingChecksDetail(
  gh: GithubRepoClient,
  runs: { id: number; name: string; status: string; conclusion: string | null; output?: { title?: string | null; summary?: string | null; text?: string | null } }[],
): Promise<string> {
  const failed = runs
    .filter((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(String(c.conclusion)))
    .slice(0, 2);
  const parts: string[] = [];
  for (const run of failed) {
    let log = "";
    try {
      const res = await gh.octokit.actions.downloadJobLogsForWorkflowRun({ owner: gh.owner, repo: gh.repo, job_id: run.id });
      const data: unknown = res.data;
      log =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : "";
    } catch {
      /* check-run nemusí být job GitHub Actions */
    }
    if (!log) log = [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n");
    parts.push(`--- Krok „${run.name}" (${run.conclusion}) ---\n${redactSecrets(log.slice(-2500), gh.token)}`);
  }
  return parts.join("\n\n");
}

/**
 * Událost jen při ZMĚNĚ důvodu (data.code) — smyčka běží každou minutu a jinak by
 * zaplavila řeku událostí. Vrací, od kdy trvá současný důvod (čas první události
 * s tímto kódem), z čehož se počítá „blokuje pořád stejný důvod přes 24 h".
 * `windowMs` = po uplynutí se stejná událost smí zapsat znovu (připomínka).
 */
async function logEventDeduped(
  input: LogEventInput,
  code: string,
  windowMs?: number,
): Promise<{ since: Date; logged: boolean }> {
  const rows = await getSql()<{ ts: Date; code: string | null }[]>`
    SELECT ts, data->>'code' AS code FROM events
    WHERE type = ${input.type}
      AND task_id IS NOT DISTINCT FROM ${input.taskId ?? null}::uuid
      AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}::uuid
    ORDER BY ts DESC LIMIT 1
  `;
  const last = rows[0];
  const lastTs = last ? new Date(last.ts) : null;
  const fresh = !windowMs || (lastTs !== null && Date.now() - lastTs.getTime() < windowMs);
  if (last && lastTs && last.code === code && fresh) {
    return { since: await streakStart(input, code, lastTs), logged: false };
  }
  await logEvent({ ...input, data: { ...(input.data ?? {}), code } });
  return { since: new Date(), logged: true };
}

/** Čas první události nepřerušené řady se stejným kódem (deduplikace zapisuje jen změny). */
async function streakStart(input: LogEventInput, code: string, fallback: Date): Promise<Date> {
  const rows = await getSql()<{ ts: Date | null }[]>`
    SELECT min(ts) AS ts FROM events
    WHERE type = ${input.type}
      AND task_id IS NOT DISTINCT FROM ${input.taskId ?? null}::uuid
      AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}::uuid
      AND data->>'code' = ${code}
      AND ts > COALESCE((
        SELECT max(ts) FROM events
        WHERE type = ${input.type}
          AND task_id IS NOT DISTINCT FROM ${input.taskId ?? null}::uuid
          AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}::uuid
          AND data->>'code' IS DISTINCT FROM ${code}
      ), '-infinity'::timestamptz)
  `;
  const ts = rows[0]?.ts;
  return ts ? new Date(ts) : fallback;
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}
