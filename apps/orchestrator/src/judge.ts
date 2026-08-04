/**
 * Judge runner loop (OVERVIEW §5.5).
 * q_judge → gVisor kontejner install/build/test/lint → diff proti main →
 * mechanická config ráčna (chráněné soubory → escalate) → LLM review (Kimi) →
 * decideNextAction (loop detection + attempts) → merge/requeue/park.
 */
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  getDb,
  getSql,
  tasks,
  attempts,
  reviews,
  wishes,
  projects,
  specs,
  approvals,
  qaRuns,
  QUEUES,
  enqueue,
  readOne,
  ackDelete,
} from "@farm/db";
import { and, eq, ne, desc } from "drizzle-orm";
import {
  loadConfig,
  taskMachine,
  attemptMachine,
  projectMachine,
  wishMachine,
  decideNextAction,
  circuitBreakerTripped,
  protectedFilesTouched,
  deletedTestFiles,
} from "@farm/core";
import type { DiffFile } from "@farm/core";
import { MODELS, structured, judgePrompt, validateJudge } from "@farm/llm";
import type { JudgeOutput } from "@farm/llm";
import type { JudgeVerdict } from "@farm/db";
import { runJudgeContainer } from "./docker.js";
import { isAutopilot } from "./settings.js";
import { mergeToMain, pushMain, openPr } from "./git.js";
import { logEvent } from "./events.js";
import { registerAgent, releaseAgent } from "./agents-registry.js";
import { enqueueReadyDependents, parkBlockedDependents } from "./dag.js";
import { reflectOnFailure, distillSuccess } from "./memory.js";
import type { JudgeMessage, TaskMessage } from "./types.js";

/**
 * Numerické skóre pokusu 0..1 z mechanických kontrol + verdiktu. Zapisuje se do
 * attempts.score (dřív se nikdy nenastavovalo). Slouží k žebříčkování pokusů
 * (nejlepší fix, podklad pro best-of-N výběr) a k transparentnímu reportingu.
 */
export function scoreAttempt(input: {
  buildOk: boolean;
  testsOk: boolean;
  lintOk: boolean;
  verdict: JudgeVerdict;
}): number {
  const verdictScore = input.verdict === "approve" ? 1 : input.verdict === "escalate" ? 0.5 : 0;
  const raw =
    0.35 * (input.buildOk ? 1 : 0) +
    0.35 * (input.testsOk ? 1 : 0) +
    0.1 * (input.lintOk ? 1 : 0) +
    0.2 * verdictScore;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}

/**
 * Mechanické skóre KANDIDÁTA best-of-N (0..1) jen z build/test/lint — bez LLM
 * verdiktu (ten je nedeterministický a běží až u vítěze). Slouží k VÝBĚRU vítěze
 * (totální řád: ORDER BY score DESC, candidate_idx ASC). Stavějící+testující kandidát
 * dostane vyšší skóre.
 */
export function scoreCandidate(input: { buildOk: boolean; testsOk: boolean; lintOk: boolean }): number {
  const raw = 0.5 * (input.buildOk ? 1 : 0) + 0.4 * (input.testsOk ? 1 : 0) + 0.1 * (input.lintOk ? 1 : 0);
  return Math.round(raw * 100) / 100;
}

// Mechanické kontroly. KLÍČOVÉ: chybějící skript = PASS (exit 0), NE selhání.
// Dřív `pnpm build/test/lint` u greenfield/scaffold projektu (bez těch skriptů)
// vracelo nenulový exit → build/tests/lint=false → judge automaticky REJECT → 0
// hotových tasků navždy. Teď skript spustíme jen když v package.json existuje;
// kvalitu jinak drží LLM review + done_condition.
export const JUDGE_CMD = [
  "set +e",
  "pnpm install --ignore-scripts >/tmp/install.log 2>&1; echo INSTALL_EXIT=$?",
  `has() { node -e 'try{const s=(require(process.cwd()+"/package.json").scripts)||{};process.exit(s[process.argv[1]]?0:1)}catch(e){process.exit(1)}' "$1"; }`,
  "if has build; then pnpm build >/tmp/build.log 2>&1; echo BUILD_EXIT=$?; else echo BUILD_EXIT=0; fi",
  "if has test; then pnpm test >/tmp/test.log 2>&1; echo TEST_EXIT=$?; else echo TEST_EXIT=0; fi",
  "if has lint; then pnpm lint >/tmp/lint.log 2>&1; echo LINT_EXIT=$?; else echo LINT_EXIT=0; fi",
].join("; ");

/** Jedna iterace judge loopu. */
export async function runJudgeOnce(): Promise<void> {
  const msg = await readOne<JudgeMessage>(QUEUES.judge);
  if (!msg) return;
  const { message, msgId } = msg;

  try {
    await judgeAttempt(message);
    await ackDelete(QUEUES.judge, msgId);
  } catch (err) {
    console.error(`[judge] posouzení attempt ${message.attemptId} selhalo:`, err);
    await logEvent({
      projectId: message.projectId,
      taskId: message.taskId,
      level: "error",
      type: "judge_error",
      message: `Judge selhal: ${String(err)}`,
    });
    // NEnech task uvíznout v 'judging' (jinak by přání nikdy nedokončilo a refill
    // by se zablokoval). Vrať task do fronty a znovu zařaď (infra chyba, ne verdikt).
    try {
      // Nedokonči pokus 'running' navěky (leak worker-cap slotu + později by ho
      // reconciliation považovala za živý). Ukliď ho na 'failed'.
      await getDb()
        .update(attempts)
        .set({ status: "failed", finishedAt: new Date(), outputSummary: "Judge selhal (infra)." })
        .where(and(eq(attempts.id, message.attemptId), eq(attempts.status, "running")));
      const tr = await getDb().select().from(tasks).where(eq(tasks.id, message.taskId)).limit(1);
      const t = tr[0];
      if (t && t.status === "judging") {
        taskMachine.assert("judging", "queued");
        await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, t.id));
        const requeue: TaskMessage = {
          taskId: t.id,
          projectId: t.projectId,
          wishId: t.wishId,
          kind: t.kind,
          isFix: true,
          note: `Judge selhal, opakuji: ${String(err).slice(0, 200)}`,
        };
        await enqueue(QUEUES.tasks, requeue);
      }
    } catch (e) {
      console.error("[judge] re-enqueue po chybě selhal:", e);
    }
    await ackDelete(QUEUES.judge, msgId);
  }
}

async function judgeAttempt(message: JudgeMessage): Promise<void> {
  const taskRows = await getDb().select().from(tasks).where(eq(tasks.id, message.taskId)).limit(1);
  const task = taskRows[0];
  if (!task || task.status !== "judging") {
    // Zastaralé (task už zpracován / superseded / reaped reconciliací). Kandidát ale
    // zůstal 'running' se score SET → žádná recon větev ho neuklidí (task není 'running'
    // ani 'judging') a visel by jako fantom navždy. Finalizuj ho na terminální 'aborted'.
    await getDb()
      .update(attempts)
      .set({ status: "aborted", finishedAt: new Date() })
      .where(and(eq(attempts.id, message.attemptId), eq(attempts.status, "running")));
    return;
  }
  // Idempotence: message.attemptId už má review → byl posouzen (redelivery po vt/
  // crash-před-ack) → přeskoč, ať nemergujeme/nepíšeme dvakrát. (Souběžné dvojí
  // posouzení navíc brání 40min visibility timeout > max wall-clock judge běhu.)
  const existingReview = await getDb()
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.attemptId, message.attemptId))
    .limit(1);
  if (existingReview.length > 0) return;
  const projRows = await getDb().select().from(projects).where(eq(projects.id, message.projectId)).limit(1);
  const project = projRows[0];
  if (!project) return;

  // Registr flotily: judge je „busy" na tomto tasku (vidí /agents + dashboard).
  const agentId = await registerAgent({
    role: "judge",
    projectId: project.id,
    model: MODELS.judge,
    currentTaskId: task.id,
  });
  try {
    await judgeWork(message, task, project);
  } finally {
    await releaseAgent(agentId);
  }
}

/** Vlastní posouzení (obalené registrem agenta v judgeAttempt). */
async function judgeWork(
  message: JudgeMessage,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  const cfg = loadConfig();

  // 1) Mechanické kontroly v gVisor kontejneru
  const run = await runJudgeContainer({ workspaceHostPath: message.worktreeRef, cmd: JUDGE_CMD });
  const buildOk = exitCode(run.stdout, "BUILD_EXIT") === 0;
  const testsOk = exitCode(run.stdout, "TEST_EXIT") === 0;
  const lintOk = exitCode(run.stdout, "LINT_EXIT") === 0;

  // 2) Diff proti main
  const { files, diffText } = await computeDiff(message.projectId, message.branch);
  const protectedTouched = protectedFilesTouched(files).map((f) => f.path);
  const deletedTests = deletedTestFiles(files).map((f) => f.path);

  // 3) Verdikt
  let verdict: JudgeVerdict;
  let reasons: string;
  let checks: Record<string, unknown>;

  // Autopilot (trust_mode / global): žádná ruční config ráčna — chráněné soubory
  // (package.json, lock…) se pod plnou autonomií řeší LLM reviewem jako běžný diff.
  const autopilot = await isAutopilot(project.trustMode);

  if (protectedTouched.length > 0 && !autopilot) {
    // Config ráčna: chráněné soubory změněny → eskalace na člověka (nikdy approve).
    verdict = "escalate";
    reasons = `Chráněné harness soubory změněny: ${protectedTouched.join(", ")}. Vyžaduje schválení config_change.`;
    checks = { build: buildOk, tests: testsOk, lint: lintOk, protected: protectedTouched };
    await getDb()
      .insert(approvals)
      .values({
        userId: project.userId,
        projectId: project.id,
        type: "config_change",
        payload: { taskId: task.id, attemptId: message.attemptId, files: protectedTouched },
        requestedBy: "judge",
      });
  } else if (deletedTests.length > 0) {
    // Ráčna na testy: smazaný test soubor → reject.
    verdict = "reject";
    reasons = `Smazané testovací soubory: ${deletedTests.join(", ")}.`;
    checks = { build: buildOk, tests: testsOk, lint: lintOk, deletedTests };
  } else {
    // 4) LLM review (Kimi)
    const spec = await latestSpecMd(task.wishId);
    const review = await structured<JudgeOutput>({
      model: MODELS.judge,
      messages: judgePrompt({
        taskTitle: task.title,
        doneCondition: task.doneCondition,
        specMd: spec,
        diff: diffText.slice(0, 24000),
        buildOk,
        testsOk,
        lintOk,
        protectedTouched,
        deletedTests,
        incremental: autopilot,
      }),
      validate: validateJudge,
      metadata: { userId: project.userId, projectId: project.id, taskId: task.id, scope: "system" },
    });
    verdict = review.data.verdict;
    reasons = review.data.reasons;
    checks = { ...review.data.checks, build: buildOk, tests: testsOk, lint: lintOk };
    // Pojistka: rozbitý build/testy nesmí projít, i kdyby model řekl approve.
    // POD AUTOPILOTEM ale NE: greenfield projekt se buildí inkrementálně a celkový
    // build/test u raných tasků legitimně padá — jinak by NIC nikdy nedokončilo (0/x).
    // Kvalitu tam drží LLM verdikt nad diffem + done_condition.
    if (!autopilot && (!buildOk || !testsOk) && verdict === "approve") {
      verdict = "reject";
      reasons = `Build/testy neprošly (build=${buildOk}, tests=${testsOk}). ${reasons}`;
    }
  }

  // Zapiš review
  await getDb().insert(reviews).values({
    attemptId: message.attemptId,
    judgeModel: MODELS.judge,
    verdict,
    checks,
    reasons,
  });

  // Numerické skóre pokusu (0..1) → attempts.score. Dřív se nikdy nezapisovalo;
  // teď je to reálný podklad pro žebříčkování a výběr nejlepšího pokusu.
  await getDb()
    .update(attempts)
    .set({ score: scoreAttempt({ buildOk, testsOk, lintOk, verdict }) })
    .where(eq(attempts.id, message.attemptId));

  // 5) Rozhodnutí guardrail vrstvy (loop detection + attempts)
  const previousOutputs = await previousAttemptOutputs(task.id, message.attemptId);
  const currentAttempt = await getDb()
    .select({ out: attempts.outputSummary })
    .from(attempts)
    .where(eq(attempts.id, message.attemptId))
    .limit(1);
  const outputSummary = currentAttempt[0]?.out ?? "";

  const decision = decideNextAction({
    judgeVerdict: verdict,
    outputSummary,
    previousOutputs,
    attemptsCount: task.attemptsCount + 1, // včetně právě dokončeného pokusu
    maxAttempts: task.maxAttempts,
    loopThreshold: cfg.loopSimilarityThreshold,
  });

  await applyDecision(decision, task, project, message, verdict, diffText);
}

type Decision = ReturnType<typeof decideNextAction>;

async function applyDecision(
  decision: Decision,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  message: JudgeMessage,
  verdict: JudgeVerdict,
  diffText: string,
): Promise<void> {
  // Stav pokusu podle SKUTEČNÉHO výsledku: 'succeeded' JEN když se práce reálně
  // dostala do main (merge/PR). Non-done akce = 'rejected' zapíšeme hned; u 'done'
  // rozhodneme až podle výsledku merge (na konfliktu se nic nezamergovalo → NEsmí
  // to být 'succeeded'). Řeší nekonzistenci "succeeded pokus u ne-hotového tasku".
  const finishAttempt = async (status: "succeeded" | "rejected" | "failed"): Promise<void> => {
    attemptMachine.assert("running", status);
    await getDb()
      .update(attempts)
      .set({ status, finishedAt: new Date() })
      .where(eq(attempts.id, message.attemptId));
  };
  if (decision.action !== "done") await finishAttempt("rejected");

  switch (decision.action) {
    case "done": {
      // Merge (nová repa farmy) nebo PR (existující repa uživatele — §9).
      if (project.repoMode === "existing") {
        const prUrl = await openPr(
          project.id,
          message.branch,
          `farm: ${task.title}`,
          `Task ${task.id}\n\n${task.doneCondition}`,
        );
        await finishAttempt("succeeded");
        await logEvent({
          projectId: project.id,
          taskId: task.id,
          type: "pr_opened",
          message: `PR otevřen (existující repo): ${prUrl}`,
          data: { prUrl },
        });
      } else {
        // SWARM: rebase-onto-main + fast-forward. Konflikt → úkol zpět workerovi
        // (jiný paralelní worker mezitím změnil main); NEoznačuj hotovo.
        const merge = await mergeToMain(project.id, message.branch);
        if (!merge.ok) {
          // Nic se nezamergovalo → pokus NENÍ 'succeeded' (kontrakt). 'failed' =
          // bez penalizace attempts_count (viz níže), práce se zopakuje.
          await finishAttempt("failed");
          // BEZ penalizace attempts_count: merge konflikt NENÍ chyba workera (judge
          // práci schválil) — jiný paralelní merge mezitím změnil main. Penalizace
          // by v rušném swarmu zaparkovala i opakovaně schvalovanou práci.
          taskMachine.assert("judging", "queued");
          await getDb()
            .update(tasks)
            .set({ status: "queued" })
            .where(eq(tasks.id, task.id));
          await enqueue(QUEUES.tasks, {
            taskId: task.id,
            projectId: project.id,
            wishId: task.wishId,
            kind: task.kind,
            isFix: true,
            note: `Merge do main ${merge.conflict ? "konflikt" : "selhal"} — rebasuj na aktuální main a vyřeš. ${merge.error ?? ""}`,
          });
          await logEvent({
            projectId: project.id,
            taskId: task.id,
            level: "warn",
            type: "merge_conflict",
            message: `Merge do main selhal (${merge.conflict ? "konflikt" : "chyba"}) — vráceno workerovi k rebasu.`,
            data: { error: merge.error },
          });
          break;
        }
        await pushMain(project.id).catch((e) =>
          console.error("[judge] pushMain selhal (pokračuji):", e),
        );
        await finishAttempt("succeeded"); // zamergováno do main → pokus je úspěch
      }
      taskMachine.assert("judging", "done");
      await getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
      // Zmergovaný pokus je vítěz (pravdivě: u best-of-N je to nejlepší kandidát,
      // u běžného tasku jediný přijatý pokus).
      await getDb()
        .update(attempts)
        .set({ isWinner: true })
        .where(eq(attempts.id, message.attemptId));
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        type: "task_done",
        message: `Task hotový: ${task.title}`,
      });
      // DAG: odblokuj a zařaď do fronty závislé tasky, jejichž všechny závislosti
      // jsou nyní 'done' (event-driven, žádný spin).
      await enqueueReadyDependents(task.id, task.wishId);
      // UČENÍ Z VÝHRY: task, který DŘÍV selhal (attemptsCount>0), teď prošel →
      // destiluj vítězný vzor do paměti (vysoký signál). První průchody přeskočíme
      // (rutinní, ať to nestojí LLM volání na každý merge).
      if (task.attemptsCount > 0) {
        await distillSuccess({
          projectId: project.id,
          userId: project.userId,
          wishId: task.wishId,
          taskId: task.id,
          taskTitle: task.title,
          doneCondition: task.doneCondition,
          // JEN skutečná dřívější SELHÁNÍ — vylouč právě zapsaný vítězný '[approve]'
          // review, ať se do „dříve překonaná selhání" nepřilepí ta výhra samotná.
          priorFailures: (await recentReviewReasons(task.id)).filter((r) => !r.startsWith("[approve]")),
          diff: diffText,
        });
      }
      // Milníky přání (25/50/75 %). 100 % řeší maybeCompleteWish přes 'wish_done'.
      await reportWishProgress(task.wishId, project);
      await maybeCompleteWish(task.wishId, project);
      break;
    }
    case "requeue": {
      taskMachine.assert("judging", "queued");
      await getDb()
        .update(tasks)
        .set({ status: "queued", attemptsCount: task.attemptsCount + 1 })
        .where(eq(tasks.id, task.id));
      await requeueTask(task, message, decision.reason, true);
      break;
    }
    case "requeue_no_penalty": {
      taskMachine.assert("judging", "queued");
      await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, task.id));
      await requeueTask(task, message, decision.reason, true);
      break;
    }
    case "park": {
      taskMachine.assert("judging", "parked");
      await getDb().update(tasks).set({ status: "parked" }).where(eq(tasks.id, task.id));
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "task_parked",
        message: `Task zaparkován: ${task.title} — ${decision.reason}`,
        data: { reason: decision.reason },
      });
      // DAG: závislé čekající tasky už nemůžou proběhnout → tranzitivně zaparkuj.
      await parkBlockedDependents(task.id, task.wishId, decision.reason);
      // Když přání už nemá žádnou spustitelnou práci a zbývají jen zablokované úkoly,
      // zaparkuj CELÉ přání — jinak visí navždy v 'active' a blokuje refill projektu.
      await maybeParkWish(task.wishId, project);
      // REFLEXE: post-mortem selhání → poučení do project_memory (příště se neopakuje).
      await reflectOnFailure({
        projectId: project.id,
        userId: project.userId,
        wishId: task.wishId,
        taskId: task.id,
        taskTitle: task.title,
        doneCondition: task.doneCondition,
        failures: await recentReviewReasons(task.id),
        evidence: `Poslední verdikt judge: ${verdict}. ${decision.reason}`,
      });
      await maybeTripProjectBreaker(project);
      break;
    }
    case "budget_hold": {
      // Guard na status='active' (jako dispatch): jinak by se u už drženého projektu
      // re-stampoval updated_at (přes $onUpdate) a posouval heldSince → auto-resume by
      // se odkládal donekonečna. Přechod jen z 'active' → hold nastane právě jednou.
      await getDb()
        .update(projects)
        .set({ status: "budget_hold" })
        .where(and(eq(projects.id, project.id), eq(projects.status, "active")));
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "budget_hold",
        message: `Projekt v budget_hold: ${decision.reason}`,
      });
      break;
    }
  }
}

/**
 * Zaparkuj CELÉ přání, když už nemá spustitelnou práci (žádný queued/running/
 * judging task) a aspoň jeden úkol je zablokovaný (parked/failed). Jinak by přání
 * uvázlo v 'active' navždy a blokovalo refill loop projektu (hasOpenWork). 'parked'
 * přání refill nezapočítává → projekt může pokračovat s jinou prací. + alert uživateli.
 */
async function maybeParkWish(
  wishId: string | null,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!wishId) return;
  const rows = await getSql()<{ runnable: number; blocked: number }[]>`
    SELECT
      count(*) FILTER (WHERE status IN ('queued','running','judging'))::int AS runnable,
      count(*) FILTER (WHERE status IN ('parked','failed'))::int AS blocked
    FROM tasks WHERE wish_id = ${wishId}
  `;
  const runnable = rows[0]?.runnable ?? 0;
  const blocked = rows[0]?.blocked ?? 0;
  if (runnable > 0 || blocked === 0) return;

  const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, wishId)).limit(1);
  const wish = wishRows[0];
  if (!wish || wish.status !== "active") return;

  wishMachine.assert("active", "parked");
  await getDb().update(wishes).set({ status: "parked" }).where(eq(wishes.id, wishId));
  await logEvent({
    projectId: project.id,
    wishId,
    level: "warn",
    type: "wish_parked",
    message: `Přání zablokované — všechny zbývající úkoly uvázly (${blocked}). Přání zaparkováno, vyžaduje zásah. Projekt pokračuje jinou prací.`,
    data: { blocked },
  });
}

/**
 * Projektový circuit breaker (OVERVIEW §8): pokud dnes v projektu zaparkovalo
 * ≥ prahu úkolů, projekt se automaticky zapauzuje a upozorní se uživatel.
 * Počítáme jen PŘÍMÉ parky (loop/vyčerpané pokusy), ne kaskádové parky závislých
 * úkolů (data.cascade=true) — jedno reálné selhání blokující podstrom by jinak
 * breaker spustilo falešně.
 */
async function maybeTripProjectBreaker(project: typeof projects.$inferSelect): Promise<void> {
  if (project.status !== "active") return;
  const cfg = loadConfig();
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM events
    WHERE project_id = ${project.id}
      AND type = 'task_parked'
      AND (data->>'cascade') IS DISTINCT FROM 'true'
      AND ts >= date_trunc('day', now() at time zone 'UTC')
  `;
  const parkedToday = rows[0]?.n ?? 0;
  if (!circuitBreakerTripped(parkedToday, cfg.circuitBreakerProjectFailures)) return;

  projectMachine.assert("active", "paused");
  await getDb().update(projects).set({ status: "paused" }).where(eq(projects.id, project.id));
  await logEvent({
    projectId: project.id,
    level: "warn",
    type: "circuit_breaker",
    message: `Circuit breaker: ${parkedToday} zaparkovaných úkolů dnes — projekt pozastaven.`,
    data: { parkedToday, threshold: cfg.circuitBreakerProjectFailures },
  });
  await logEvent({
    projectId: project.id,
    level: "warn",
    type: "project_paused_auto",
    message: "Projekt automaticky pozastaven (circuit breaker). Obnov ho ručně po kontrole.",
  });
}

/** Re-enqueue tasku do q_tasks (isFix → worker-fix agent). */
async function requeueTask(
  task: typeof tasks.$inferSelect,
  message: JudgeMessage,
  reason: string,
  isFix: boolean,
): Promise<void> {
  const msg: TaskMessage = {
    taskId: task.id,
    projectId: message.projectId,
    wishId: task.wishId,
    kind: task.kind,
    isFix,
    note: reason,
  };
  await enqueue(QUEUES.tasks, msg);
}

/**
 * Milníky postupu přání: spočítá done/total tasků a při překročení
 * 25/50/75 % emitne 'wish_progress' (data.percent, data.wishTitle).
 * Poslední ohlášený práh čte z events (idempotence + žádný spam);
 * 100 % neřeší — to je 'wish_done' z maybeCompleteWish.
 */
async function reportWishProgress(
  wishId: string | null,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!wishId) return;

  const totals = await getSql()<{ total: number; done: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'done')::int AS done
    FROM tasks
    WHERE wish_id = ${wishId}
  `;
  const total = totals[0]?.total ?? 0;
  const done = totals[0]?.done ?? 0;
  if (total === 0) return;

  const percent = Math.round((done / total) * 100);

  // Nejvyšší překročený milník < 100 (100 = wish_done).
  const milestones = [25, 50, 75];
  const crossed = milestones.filter((m) => percent >= m);
  const highest = crossed.length > 0 ? crossed[crossed.length - 1]! : 0;
  if (highest === 0) return;

  // Poslední ohlášený milník z events (ať neohlásíme stejný práh dvakrát).
  const last = await getSql()<{ last: number }[]>`
    SELECT COALESCE(MAX((data->>'percent')::int), 0) AS last
    FROM events
    WHERE wish_id = ${wishId} AND type = 'wish_progress'
  `;
  const lastReported = last[0]?.last ?? 0;
  if (highest <= lastReported) return;

  const wishRows = await getDb()
    .select({ title: wishes.title })
    .from(wishes)
    .where(eq(wishes.id, wishId))
    .limit(1);
  const wishTitle = wishRows[0]?.title ?? "přání";

  await logEvent({
    projectId: project.id,
    wishId,
    type: "wish_progress",
    message: `Přání „${wishTitle}" hotové z ${highest} %.`,
    data: { percent: highest, wishTitle },
  });
}

/**
 * Když jsou všechny tasky přání hotové, NEuzavírá přání přímo — předá ho
 * Testerovi (q_qa) k finální end-to-end + vizuální verifikaci. Teprve Tester
 * (tester.ts) přání uzavře (active → done) a zařadí preview deploy, nebo při
 * selhání založí opravné tasky (self-healing). Tím se ověří, že to, co agenti
 * postavili, skutečně funguje — funkčně i vizuálně.
 */
async function maybeCompleteWish(
  wishId: string | null,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!wishId) return;
  const remaining = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.wishId, wishId), ne(tasks.status, "done")))
    .limit(1);
  if (remaining.length > 0) return;
  const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, wishId)).limit(1);
  const wish = wishRows[0];
  if (!wish || wish.status !== "active") return;

  // Idempotence: neduplikuj QA běh, když už jeden pro toto přání běží.
  const running = await getDb()
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(and(eq(qaRuns.wishId, wishId), eq(qaRuns.status, "running")))
    .limit(1);
  if (running.length > 0) return;

  await enqueue(QUEUES.qa, { projectId: project.id, wishId });
  await logEvent({
    projectId: project.id,
    wishId,
    type: "qa_enqueued",
    message: `Všechny úkoly přání „${wish.title}" hotové — předáno Testerovi k finální verifikaci.`,
  });
}

/** Důvody posledních rejectů/eskalací tasku (podklad pro reflexi po parkování). */
async function recentReviewReasons(taskId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ verdict: reviews.verdict, reasons: reviews.reasons })
    .from(reviews)
    .innerJoin(attempts, eq(reviews.attemptId, attempts.id))
    .where(eq(attempts.taskId, taskId))
    .orderBy(desc(reviews.createdAt))
    .limit(5);
  return rows
    .map((r) => `[${r.verdict}] ${r.reasons ?? ""}`.trim())
    .filter((s) => s.length > 3);
}

/** Výstupy předchozích pokusů téhož tasku (loop detection). */
async function previousAttemptOutputs(taskId: string, currentAttemptId: string): Promise<string[]> {
  // Best-of-N SOUROZENCI (kandidáti stejného kola) mají stejný base msgId
  // (`<msg>#c<idx>`) — soupeřící kandidáti dávají přirozeně podobný výstup, takže
  // by loop detection FALEŠNĚ hlásila „opakuje se". Sourozence stejného kola proto
  // z porovnání vyloučíme; retry z JINÉHO kola má jiný base msgId → loop se dál chytá.
  const cur = await getDb()
    .select({ msgId: attempts.msgId })
    .from(attempts)
    .where(eq(attempts.id, currentAttemptId))
    .limit(1);
  const curBase = (cur[0]?.msgId ?? "").replace(/#c\d+$/, "");
  const rows = await getDb()
    .select({ out: attempts.outputSummary, msgId: attempts.msgId })
    .from(attempts)
    .where(and(eq(attempts.taskId, taskId), ne(attempts.id, currentAttemptId)))
    .orderBy(desc(attempts.startedAt))
    .limit(12);
  return rows
    .filter((r) => (r.msgId ?? "").replace(/#c\d+$/, "") !== curBase)
    .map((r) => r.out ?? "")
    .filter((s) => s.length > 0)
    .slice(0, 5);
}

async function latestSpecMd(wishId: string | null): Promise<string | undefined> {
  if (!wishId) return undefined;
  const rows = await getDb()
    .select({ md: specs.contentMd })
    .from(specs)
    .where(eq(specs.wishId, wishId))
    .orderBy(desc(specs.version))
    .limit(1);
  return rows[0]?.md;
}

/** Diff branche proti main: seznam souborů (name-status) + plný text diffu. */
async function computeDiff(
  projectId: string,
  branch: string,
): Promise<{ files: DiffFile[]; diffText: string }> {
  const wsPath = join(loadConfig().workspacesRoot, projectId);
  const git = simpleGit(wsPath);
  const base = "main";
  const range = `${base}...${branch}`;

  let nameStatus = "";
  let diffText = "";
  try {
    nameStatus = await git.raw(["diff", "--name-status", range]);
    diffText = await git.raw(["diff", range]);
  } catch {
    // Fallback: dvojtečkový rozsah nemusí jít (bez společného předka) → přímé srovnání.
    nameStatus = await git.raw(["diff", "--name-status", base, branch]).catch(() => "");
    diffText = await git.raw(["diff", base, branch]).catch(() => "");
  }

  const files: DiffFile[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split("\t");
    const code = cols[0] ?? "";
    const letter = code.charAt(0);
    if (letter === "A") files.push({ path: cols[1] ?? "", status: "added" });
    else if (letter === "M") files.push({ path: cols[1] ?? "", status: "modified" });
    else if (letter === "D") files.push({ path: cols[1] ?? "", status: "deleted" });
    else if (letter === "R") files.push({ path: cols[2] ?? cols[1] ?? "", status: "renamed" });
    else if (cols[1]) files.push({ path: cols[1], status: "modified" });
  }
  return { files, diffText };
}

/** Vytáhne exit kód z výstupu (řádek `NAME_EXIT=<n>`). Chybějící → -1. */
export function exitCode(stdout: string, marker: string): number {
  const m = stdout.match(new RegExp(`${marker}=(\\d+)`));
  return m && m[1] !== undefined ? Number(m[1]) : -1;
}
