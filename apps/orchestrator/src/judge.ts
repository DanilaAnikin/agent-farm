/**
 * Judge runner loop (OVERVIEW §5.5).
 * q_judge → gVisor kontejner install/build/test/lint → diff proti main →
 * mechanická config ráčna (chráněné soubory → escalate) → LLM review (Kimi) →
 * decideNextAction (loop detection + attempts) → merge/requeue/park.
 */
import { promises as fs } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
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
import { and, eq, ne, desc, inArray } from "drizzle-orm";
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
  deriveHarnessPlan,
  extractWorkflowRunCommands,
  harnessScript,
  parseHarnessOutput,
  isHarnessRunBroken,
  newlyBrokenChecks,
  HARNESS_CHECKS,
} from "@farm/core";
import type { DiffFile, HarnessCheck, HarnessPlan, HarnessRun } from "@farm/core";
import { MODELS, structured, judgePrompt, validateJudge, isLlmBudgetError } from "@farm/llm";
import type { JudgeOutput } from "@farm/llm";
import type { JudgeVerdict, ParkReason } from "@farm/db";
import { runJudgeContainer } from "./docker.js";
import { isAutopilot } from "./settings.js";
import { mergeToMain, pushMain, deliverToPullRequest, mainHeadSha, withDetachedWorktree, redactSecrets } from "./git.js";
import { logEvent } from "./events.js";
import { registerAgent, releaseAgent } from "./agents-registry.js";
import { enqueueReadyDependents, parkBlockedDependents, lastReplanAt, isSupersededTask } from "./dag.js";
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

    // A daily/monthly pause may outlast every retry. Keep the completed artifact
    // and the same judge message, without consuming the infrastructure retry limit.
    if (isLlmBudgetError(err)) {
      await enqueue(QUEUES.judge, message, 3600);
      await ackDelete(QUEUES.judge, msgId);
      await logEvent({
        projectId: message.projectId, taskId: message.taskId,
        type: "judge_budget_deferred", level: "info",
        message: "Posouzení čeká na rozpočet; hotový pracovní výsledek je zachován.",
      });
      return;
    }

    // 402 (vyčerpaný rozpočet) / 429 (rate limit) NENÍ chyba pokusu — pokus je
    // hotový a ZAPLACENÝ. Původní kód ho i tak označil 'failed' a přehodil celý
    // task zpátky do fronty, takže se zahazovala hotová práce a task se dělal
    // znovu — jen aby narazil na tentýž strop (303× za jedno odpoledne, výsledek
    // 3 úspěchy/den). Správně: nech stav být a zopakuj JEN judge s odstupem.
    const errText = String(err);
    const transient = /\b(402|429)\b|budget|rate.?limit|too many requests/i.test(errText);
    const judgeRetries = (message.judgeRetries ?? 0) + 1;
    const MAX_JUDGE_RETRIES = Number(process.env.MAX_JUDGE_RETRIES ?? 8);
    if (transient && judgeRetries <= MAX_JUDGE_RETRIES) {
      // Rozpočet se resetuje v denním okně → u 402 čekej dlouho, u 429 krátce.
      const isBudget = /\b402\b|budget/i.test(errText);
      const delaySec = isBudget
        ? Math.min(3600, 900 * judgeRetries)
        : Math.min(300, 15 * 2 ** judgeRetries);
      await logEvent({
        projectId: message.projectId,
        taskId: message.taskId,
        level: "warn",
        type: "judge_retry_transient",
        message: `Judge odložen o ${delaySec} s (${isBudget ? "rozpočet 402" : "rate limit 429"}, pokus ${judgeRetries}/${MAX_JUDGE_RETRIES}) — hotová práce zachována.`,
      });
      await enqueue(QUEUES.judge, { ...message, judgeRetries }, delaySec);
      await ackDelete(QUEUES.judge, msgId);
      return;
    }

    await logEvent({
      projectId: message.projectId,
      taskId: message.taskId,
      level: "error",
      type: "judge_error",
      message: `Judge selhal: ${errText}`,
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

  // 1) Mechanické kontroly v gVisor kontejneru.
  // repo_mode='new' beze změny (JUDGE_CMD). U existujícího repa se příkazy odvodí
  // z repa samotného a porovnají s baseline nad main — viz runExistingHarness.
  let harness: ExistingHarness | null = null;
  let buildOk: boolean;
  let testsOk: boolean;
  let lintOk: boolean;
  if (project.repoMode === "existing") {
    harness = await runExistingHarness(project, message.worktreeRef);
    // Rozbitý harness (infrastruktura) → posudek odložit, nic nehodnotit.
    if (await deferOnBrokenHarness(project, task, message, harness)) return;
    // Pro LLM i skóre „prošlo" = kandidát kontrolu NErozbil (padala už na main).
    buildOk = !harness.newlyBroken.includes("build");
    testsOk = !harness.newlyBroken.includes("tests");
    lintOk = !harness.newlyBroken.includes("lint");
  } else {
    const run = await runJudgeContainer({ workspaceHostPath: message.worktreeRef, cmd: JUDGE_CMD });
    buildOk = exitCode(run.stdout, "BUILD_EXIT") === 0;
    testsOk = exitCode(run.stdout, "TEST_EXIT") === 0;
    lintOk = exitCode(run.stdout, "LINT_EXIT") === 0;
  }

  // 2) Diff proti main
  const { files, diffText, error: diffError } = await computeDiff(message.projectId, message.branch);

  // 2a) Diff se NEPODAŘILO spočítat → je to infra chyba, ne chyba workera.
  // Poslat judgeovi prázdný diff znamená jistý reject za něco, co worker možná
  // udělal správně (a po 3 takových rejectech task navždy skončí v 'parked').
  // Společný odchod: pokus uzavřít, task zpět do fronty BEZ penalizace.
  const requeueWithoutPenalty = async (
    attemptStatus: "aborted" | "rejected",
    note: string,
  ): Promise<void> => {
    await getDb()
      .update(attempts)
      .set({ status: attemptStatus, finishedAt: new Date() })
      .where(and(eq(attempts.id, message.attemptId), eq(attempts.status, "running")));
    taskMachine.assert("judging", "queued");
    await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, task.id));
    await requeueTask(task, message, note, true);
  };

  if (diffError) {
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      type: "judge_diff_unavailable",
      message: `Diff proti main nešel spočítat (${diffError}) — vracím do fronty BEZ penalizace, nehodnotím.`,
    });
    await requeueWithoutPenalty("aborted", "Diff se nepodařilo spočítat (infra) — zkus to znovu.");
    return;
  }

  // 2b) Worker legitimně nic nezměnil. Taky se to NESMÍ hodnotit jako špatná
  // práce: typicky znamená „done condition už v mainu platí" (worker to sám
  // ověřil a napsal do output_summary). Reject by jen spálil pokus.
  if (files.length === 0) {
    // OHRANIČENÍ: requeue bez penalizace nesmí cyklit donekonečna. Když worker
    // opakovaně nic nezmění, je zadání nejspíš vadné nebo už splněné → park
    // s jasným důvodem (ne tichý reject za „chybějící diff").
    const emptyRows = await getSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
      WHERE task_id = ${task.id} AND type = 'judge_empty_diff'
    `;
    const emptyCount = (emptyRows[0]?.n ?? 0) + 1;
    const MAX_EMPTY_DIFF = Number(process.env.MAX_EMPTY_DIFF_RETRIES ?? 3);
    if (emptyCount > MAX_EMPTY_DIFF) {
      // Žádné „vyžaduje pohled člověka": soudce nad aktuálním kódem rozhodne, jestli
      // cíl už platí (→ úkol splněn), jinak se úkol vrací plánovači k přeformulování.
      await resolveEmptyDiff(task, project, message, MAX_EMPTY_DIFF);
      return;
    }
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "info",
      type: "judge_empty_diff",
      message: "Worker neprovedl žádnou změnu — vracím do fronty s výzvou doložit, že cíl už platí.",
    });
    await requeueWithoutPenalty(
      "rejected",
      "Neprovedl jsi žádnou změnu. Buď úkol skutečně proveď, nebo — pokud done condition v mainu " +
        "už platí — to DOLOŽ konkrétním odkazem na soubor a řádek ve shrnutí.",
    );
    return;
  }

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
      metadata: { userId: project.userId, projectId: project.id, wishId: task.wishId ?? undefined, taskId: task.id, scope: "system" },
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
    // Autopilot: „escalate na člověka" nedává smysl (žádný člověk neschvaluje) →
    // ber to jako reject a nech farmu zkusit task znovu (fix). Po max pokusech se
    // stejně zaparkuje, takže se nikdy neuvázne na čekání na lidský zásah.
    if (autopilot && verdict === "escalate") {
      verdict = "reject";
      reasons = `[autopilot: escalate→reject] ${reasons}`;
    }
  }

  // Existující repo: kontroly vynucené BEZ OHLEDU na autopilot. Blokují jen ty,
  // které tahle změna NOVĚ rozbila — co padá už na main, práci workera neshodí.
  if (harness) {
    checks = {
      ...checks,
      typecheck: !harness.newlyBroken.includes("typecheck"),
      harness: {
        packageManager: harness.plan.packageManager,
        sources: harness.plan.source,
        baselineSha: harness.baselineSha,
        newlyBroken: harness.newlyBroken,
        exits: harness.candidate.exits,
        baselineExits: harness.baseline?.exits ?? null,
      },
    };
    if (harness.newlyBroken.length > 0) {
      if (verdict === "approve") verdict = "reject";
      reasons = `Tahle změna nově rozbila kontroly: ${harness.newlyBroken.join(", ")}.${harnessLogTail(harness)}\n${reasons}`;
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

  // Infra prokazatelně fungovala (worker doběhl, diff se spočítal, judge vydal
  // verdikt) → vynuluj čítač infra requeue. Jinak by se dřívější dočasné výpadky
  // sčítaly přes celý život tasku a nakonec ho zaparkovaly uprostřed zdravé práce.
  await getDb().update(tasks).set({ infraRetries: 0 }).where(eq(tasks.id, task.id));

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
        /*
          Otevřený PR NENÍ hotový úkol. Úkol jde `judging → merging` a do `done` ho
          přepne až merge smyčka (delivery.ts) po potvrzeném sloučení. Až tam se
          také odblokují závislé úkoly a počítá postup přání.

          Proč pokus uzavírám jako 'succeeded' HNED, a ne až po merge: reconciliation
          (reconcileStaleAttempts) reapuje jen pokusy úkolů ve stavu 'running' a
          judging-recovery jen 'judging' — pokus úkolu v 'merging' by tedy nikdo
          nikdy neuzavřel. Zůstal by viset jako „běžící worker" (dashboard, registr),
          po převodu na opravu by vedle něj běžel nový pokus a Tester by schválený
          artefakt nenašel (hledá 'succeeded'). Pokus je hotová a schválená práce;
          pravdivost doručení drží výhradně stav ÚKOLU (merging vs. done) a
          is_winner, který nastaví až merge smyčka.
        */
        await finishAttempt("succeeded");
        // Selhání otevření PR NEvrací práci k přepracování: úkol přesto jde do
        // 'merging' a merge smyčka zopakuje jen doručovací krok.
        await deliverApprovedAttempt(project, task, message.attemptId, message.branch);
        taskMachine.assert("judging", "merging");
        await getDb().update(tasks).set({ status: "merging" }).where(eq(tasks.id, task.id));
        await logEvent({
          projectId: project.id,
          taskId: task.id,
          type: "task_merging",
          message: `Soudce práci schválil: ${task.title} — farma PR sloučí sama, jakmile projde CI a přísná brána.`,
        });
        await learnFromWin(task, project, diffText);
        break;
      }

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
      await learnFromWin(task, project, diffText);
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
      await getDb()
        .update(tasks)
        .set({ status: "parked", parkReason: "judge_exhausted", parkedAt: new Date() })
        .where(eq(tasks.id, task.id));
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "task_parked",
        message: `Úkol zaparkován: ${task.title} — ${decision.reason}. Farma přání přeplánuje, jakmile doběhne ostatní práce.`,
        data: { reason: decision.reason, parkReason: "judge_exhausted" },
      });
      // DAG: závislé čekající tasky už nemůžou proběhnout → tranzitivně zaparkuj.
      await parkBlockedDependents(task.id, task.wishId, decision.reason);
      // Když přání už nemá žádnou spustitelnou práci a zbývají jen zablokované úkoly,
      // farma ho PŘEPLÁNUJE (s tvrdým limitem kol) — jinak by viselo v 'active'.
      await maybeReplanStuckWish(task.wishId, project);
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
 * Přání bez spustitelné práce (žádný queued/running/judging/merging úkol), kde aspoň
 * jeden úkol uvázl (parked/failed PO posledním přeplánování), farma PŘEPLÁNUJE.
 * Dřív se celé přání zaparkovalo s „vyžaduje zásah" — a čekalo na člověka navždy.
 */
export async function maybeReplanStuckWish(
  wishId: string | null,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!wishId) return;
  const replanAt = await lastReplanAt(wishId);
  const rows = await getSql()<{ runnable: number; blocked: number }[]>`
    SELECT
      count(*) FILTER (WHERE status IN ('queued','running','judging','merging'))::int AS runnable,
      count(*) FILTER (
        WHERE status = 'failed'
           OR (status = 'parked' AND (${replanAt}::timestamptz IS NULL
               OR COALESCE(parked_at, updated_at) > ${replanAt}::timestamptz))
      )::int AS blocked
    FROM tasks WHERE wish_id = ${wishId}
  `;
  const runnable = rows[0]?.runnable ?? 0;
  const blocked = rows[0]?.blocked ?? 0;
  if (runnable > 0 || blocked === 0) return;

  await replanWishOrPark({
    wishId,
    project,
    cause: "tasks_blocked",
    leftoverParkReason: "dependency_cascade",
    summary: `uvázlo ${blocked} úkolů`,
  });
}

/** Kolikrát smí farma jedno přání přeplánovat, než ho odloží (tvrdý limit kol). */
const MAX_WISH_REPLANS = Number(process.env.MAX_WISH_REPLANS ?? 2);

/**
 * Automatické pokračování místo „vyžaduje ruční zásah": přání se vrátí plánovači
 * (active → specifying → new; manager vygeneruje novou verzi specifikace a nový
 * plán). Zbylé nedokončené úkoly se zaparkují s důvodem a nový plán je nahradí
 * (isSupersededTask). Po MAX_WISH_REPLANS kolech se přání odloží, aby farma
 * nepálila rozpočet na něčem, co opakovaně nejde — a projekt pokračuje jinou prací.
 *
 * Neběží, dokud v přání něco pracuje (running/judging/merging): přeplánování by
 * se jinak rozjelo nad rozpracovanou a třeba i úspěšnou prací.
 */
export async function replanWishOrPark(input: {
  wishId: string | null;
  project: typeof projects.$inferSelect;
  cause: "empty_diff" | "qa_exhausted" | "tasks_blocked";
  leftoverParkReason: ParkReason;
  summary: string;
}): Promise<"replanned" | "parked" | "skipped"> {
  const { wishId, project } = input;
  if (!wishId) return "skipped";
  const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, wishId)).limit(1);
  const wish = wishRows[0];
  if (!wish || wish.status !== "active") return "skipped";

  const busy = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.wishId, wishId), inArray(tasks.status, ["running", "judging", "merging"])))
    .limit(1);
  if (busy.length > 0) return "skipped";

  const roundRows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events WHERE wish_id = ${wishId} AND type = 'wish_replanned'
  `;
  const rounds = roundRows[0]?.n ?? 0;

  if (rounds >= MAX_WISH_REPLANS) {
    wishMachine.assert("active", "parked");
    const parked = await getDb()
      .update(wishes)
      .set({ status: "parked" })
      .where(and(eq(wishes.id, wishId), eq(wishes.status, "active")))
      .returning({ id: wishes.id });
    if (parked.length === 0) return "skipped";
    await logEvent({
      projectId: project.id,
      wishId,
      level: "warn",
      type: "wish_parked",
      message: `Přání „${wish.title}" se nepodařilo dokončit ani po ${rounds} přeplánováních (${input.summary}). Farma ho odkládá, aby nepálila rozpočet, a pokračuje jinou prací projektu.`,
      data: { cause: input.cause, rounds },
    });
    return "parked";
  }

  // Zbylou nedokončenou práci nahradí nový plán.
  await getDb()
    .update(tasks)
    .set({ status: "parked", parkReason: input.leftoverParkReason, parkedAt: new Date() })
    .where(and(eq(tasks.wishId, wishId), inArray(tasks.status, ["queued", "failed"])));

  // Událost PŘED změnou stavu: její čas je hranice, podle které se staré úkoly
  // počítají jako nahrazené (isSupersededTask).
  await logEvent({
    projectId: project.id,
    wishId,
    level: "warn",
    type: "wish_replanned",
    message: `Farma přání „${wish.title}" přeplánuje (kolo ${rounds + 1}/${MAX_WISH_REPLANS}): ${input.summary}.`,
    data: { cause: input.cause, round: rounds + 1 },
  });
  wishMachine.assert("active", "specifying");
  wishMachine.assert("specifying", "new");
  await getDb()
    .update(wishes)
    .set({ status: "new" })
    .where(and(eq(wishes.id, wishId), eq(wishes.status, "active")));
  return "replanned";
}

/**
 * Projektový circuit breaker (OVERVIEW §8): pokud dnes v projektu zaparkovalo
 * ≥ prahu úkolů, projekt se automaticky zapauzuje a upozorní se uživatel.
 * Počítáme jen PŘÍMÉ parky (loop/vyčerpané pokusy), ne kaskádové parky závislých
 * úkolů (data.cascade=true) — jedno reálné selhání blokující podstrom by jinak
 * breaker spustilo falešně.
 */
const CIRCUIT_BREAKER_PAUSE_HOURS = Number(process.env.CIRCUIT_BREAKER_PAUSE_HOURS ?? 6);

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

  // Časová pauza, ne trvalé zastavení: budget-hold.ts projekt po `resumeAt`
  // obnoví sám (a jen tehdy, když to dovolí rozpočet a kredity).
  const hours = CIRCUIT_BREAKER_PAUSE_HOURS;
  const resumeAt = new Date(Date.now() + hours * 60 * 60_000);
  projectMachine.assert("active", "paused");
  await getDb().update(projects).set({ status: "paused" }).where(eq(projects.id, project.id));
  await logEvent({
    projectId: project.id,
    level: "warn",
    type: "circuit_breaker",
    message: `Circuit breaker: ${parkedToday} zaparkovaných úkolů dnes — projekt se na ${hours} h pozastaví a pak se sám obnoví.`,
    data: { parkedToday, threshold: cfg.circuitBreakerProjectFailures, resumeAt: resumeAt.toISOString() },
  });
  await logEvent({
    projectId: project.id,
    level: "warn",
    type: "project_paused_auto",
    message: `Projekt automaticky pozastaven (circuit breaker) na ${hours} h — farma ho pak obnoví sama.`,
    data: { resumeAt: resumeAt.toISOString(), hours },
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
export async function reportWishProgress(
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
export async function maybeCompleteWish(
  wishId: string | null,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!wishId) return;
  // Úkoly nahrazené přeplánováním dokončení nebrání (jinak by přání po přeplánování
  // nikdy neskončilo). 'merging' dokončení brání — PR ještě není sloučený.
  const replanAt = await lastReplanAt(wishId);
  const wishTasks = await getDb()
    .select({ status: tasks.status, parkReason: tasks.parkReason, parkedAt: tasks.parkedAt, updatedAt: tasks.updatedAt })
    .from(tasks)
    .where(eq(tasks.wishId, wishId));
  if (wishTasks.some((t) => t.status !== "done" && !isSupersededTask(t, replanAt))) return;
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

/**
 * Diff branche proti main: seznam souborů (name-status) + plný text diffu.
 *
 * `error` rozlišuje DVA stavy, které se dřív obě jevily jako prázdný string:
 *   - diff se nepodařilo spočítat (infra chyba) → NESMÍ se posílat judgeovi
 *   - worker skutečně nic nezměnil (legitimní výsledek)
 * Splynutí těchto dvou stavů stálo 32 % všech zamítnutí („No diff content
 * provided") a přes ně cestu do 'parked'.
 */
async function computeDiff(
  projectId: string,
  branch: string,
): Promise<{ files: DiffFile[]; diffText: string; error?: string }> {
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
    try {
      nameStatus = await git.raw(["diff", "--name-status", base, branch]);
      diffText = await git.raw(["diff", base, branch]);
    } catch (err) {
      return { files: [], diffText: "", error: String(err).slice(0, 300) };
    }
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

/** Poučení z úspěchu (sdíleno větví merge i PR). */
async function learnFromWin(
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  diffText: string,
): Promise<void> {
  // UČENÍ Z VÝHRY: task, který DŘÍV selhal (attemptsCount>0), teď prošel →
  // destiluj vítězný vzor do paměti (vysoký signál). První průchody přeskočíme
  // (rutinní, ať to nestojí LLM volání na každý merge).
  if (task.attemptsCount === 0) return;
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

/**
 * Doručovací krok pro existující repo: push + PR (nebo push do už otevřeného PR
 * úkolu, když jde o opravu po zablokovaném merge). Uloží pr_number/head_sha do
 * pokusu. Selhání NEvyhazuje — merge smyčka ho zopakuje, schválená práce zůstává.
 */
export async function deliverApprovedAttempt(
  project: typeof projects.$inferSelect,
  task: typeof tasks.$inferSelect,
  attemptId: string,
  branch: string,
): Promise<{ ok: true; prNumber: number; headSha: string; prUrl: string } | { ok: false; error: string }> {
  const previous = await getDb()
    .select({ prNumber: attempts.prNumber })
    .from(attempts)
    .where(and(eq(attempts.taskId, task.id), ne(attempts.id, attemptId)))
    .orderBy(desc(attempts.startedAt))
    .limit(12);
  const existingPrNumber = previous.find((a) => a.prNumber !== null)?.prNumber ?? null;
  try {
    const pr = await deliverToPullRequest({
      projectId: project.id,
      branch,
      title: `farm: ${task.title}`,
      body: `Task ${task.id}\n\n${task.doneCondition}`,
      existingPrNumber,
    });
    await getDb()
      .update(attempts)
      .set({ prNumber: pr.prNumber, headSha: pr.headSha })
      .where(eq(attempts.id, attemptId));
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      type: "pr_opened",
      message: pr.reused
        ? `Oprava pushnuta do PR #${pr.prNumber}: ${pr.prUrl}`
        : `PR #${pr.prNumber} otevřen: ${pr.prUrl}`,
      data: { prUrl: pr.prUrl, prNumber: pr.prNumber, headSha: pr.headSha, branch: pr.headRef, reused: pr.reused, attemptId },
    });
    return { ok: true, prNumber: pr.prNumber, headSha: pr.headSha, prUrl: pr.prUrl };
  } catch (err) {
    const error = redactSecrets(String(err));
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      type: "pr_open_failed",
      message: "Otevření PR se nepovedlo — farma doručení zopakuje sama, schválená práce zůstává.",
      data: { error, attemptId },
    });
    return { ok: false, error };
  }
}

/**
 * Worker opakovaně nic nezměnil. Soudce nad aktuálním kódem (soubory, na které se
 * worker odvolává) rozhodne, jestli done_condition už platí:
 *   ano → úkol splněný bez změny (done, pokus succeeded + vítěz),
 *   ne  → úkol zaparkovaný s park_reason='empty_diff' a přání jde plánovači
 *         k přeformulování (replanWishOrPark, s limitem kol).
 */
async function resolveEmptyDiff(
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  message: JudgeMessage,
  maxEmpty: number,
): Promise<void> {
  const cur = await getDb()
    .select({ out: attempts.outputSummary })
    .from(attempts)
    .where(eq(attempts.id, message.attemptId))
    .limit(1);
  const summary = cur[0]?.out ?? "";
  const evidence = await citedFileExcerpts(message.worktreeRef, summary);
  const review = await structured<JudgeOutput>({
    model: MODELS.judge,
    messages: judgePrompt({
      taskTitle: task.title,
      doneCondition: task.doneCondition,
      specMd: await latestSpecMd(task.wishId),
      diff:
        "NO CODE CHANGE WAS MADE. The worker claims the done condition ALREADY HOLDS on the main branch.\n" +
        "Approve ONLY if the file excerpts below prove it; otherwise reject.\n\n" +
        `WORKER SUMMARY:\n${summary.slice(0, 4000)}\n\nFILES CITED BY THE WORKER (current content):\n${evidence || "(none)"}`,
      buildOk: true,
      testsOk: true,
      lintOk: true,
      protectedTouched: [],
      deletedTests: [],
      incremental: true,
    }),
    validate: validateJudge,
    metadata: { userId: project.userId, projectId: project.id, wishId: task.wishId ?? undefined, taskId: task.id, scope: "system" },
  });
  const doneMet = (review.data.checks as Record<string, unknown> | undefined)?.done_condition_met;
  const satisfied = review.data.verdict === "approve" && doneMet !== false;

  await getDb().insert(reviews).values({
    attemptId: message.attemptId,
    judgeModel: MODELS.judge,
    verdict: satisfied ? "approve" : "reject",
    checks: { ...(review.data.checks ?? {}), emptyDiff: true },
    reasons: `[beze změny] ${review.data.reasons}`,
  });

  if (satisfied) {
    attemptMachine.assert("running", "succeeded");
    await getDb()
      .update(attempts)
      .set({ status: "succeeded", finishedAt: new Date(), isWinner: true })
      .where(and(eq(attempts.id, message.attemptId), eq(attempts.status, "running")));
    taskMachine.assert("judging", "done");
    await getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      type: "task_done",
      message: `Úkol už v kódu platí — soudce to ověřil a farma ho uzavřela bez změny: ${task.title}`,
      data: { alreadySatisfied: true },
    });
    await enqueueReadyDependents(task.id, task.wishId);
    await reportWishProgress(task.wishId, project);
    await maybeCompleteWish(task.wishId, project);
    return;
  }

  await getDb()
    .update(attempts)
    .set({ status: "rejected", finishedAt: new Date() })
    .where(and(eq(attempts.id, message.attemptId), eq(attempts.status, "running")));
  taskMachine.assert("judging", "parked");
  await getDb()
    .update(tasks)
    .set({ status: "parked", parkReason: "empty_diff", parkedAt: new Date() })
    .where(eq(tasks.id, task.id));
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    level: "warn",
    type: "task_parked_empty_diff",
    message: `Worker ${maxEmpty}× nic nezměnil a soudce nepotvrdil, že cíl už v kódu platí — farma úkol vrací plánovači k přeformulování.`,
    data: { reason: review.data.reasons?.slice(0, 500) ?? "", parkReason: "empty_diff" },
  });
  await parkBlockedDependents(task.id, task.wishId, "empty_diff");
  await replanWishOrPark({
    wishId: task.wishId,
    project,
    cause: "empty_diff",
    leftoverParkReason: "empty_diff",
    summary: `úkol „${task.title}" opakovaně nevedl k žádné změně`,
  });
}

/**
 * Výňatky souborů, na které se worker ve shrnutí odvolává (cesta, případně :řádek).
 * Jen uvnitř worktree — cesta mimo (`..`, absolutní) se ignoruje.
 */
async function citedFileExcerpts(root: string, summary: string): Promise<string> {
  const paths = new Set<string>();
  for (const m of summary.matchAll(/([A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?/g)) {
    const p = (m[1] ?? "").replace(/^\.\//, "");
    if (!p || isAbsolute(p) || p.includes("..")) continue;
    paths.add(p);
    if (paths.size >= 5) break;
  }
  const parts: string[] = [];
  for (const p of paths) {
    const abs = join(root, p);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    try {
      const text = await fs.readFile(abs, "utf8");
      parts.push(`--- ${p} ---\n${text.slice(0, 3000)}`);
    } catch {
      /* neexistující cesta = worker se odvolává na něco, co není */
    }
  }
  return parts.join("\n\n");
}

// --- Kontroly existujícího repa (build/testy/lint/typecheck) --------------------

interface ExistingHarness {
  plan: HarnessPlan;
  candidate: HarnessRun;
  /** Zdravý běh nad main; null = nešel změřit (pak se blokuje každá padající kontrola). */
  baseline: HarnessRun | null;
  baselineSha: string | null;
  newlyBroken: HarnessCheck[];
  /** Harness nešel spustit (infrastruktura) — nehodnotit, odložit. */
  broken: boolean;
}

interface BaselineResult {
  plan: HarnessPlan;
  run: HarnessRun;
}

/**
 * Baseline nad main, cachovaná na běh orchestrátoru podle (projekt, SHA main,
 * env_recipe). Main se mění jen merge — mezi merge stačí změřit jednou; souběžné
 * judge sloty sdílí tentýž slib. Rozbitý nebo nezměřený běh se necachuje.
 */
const baselineCache = new Map<string, Promise<BaselineResult | null>>();
const BASELINE_CACHE_MAX = 50;

async function loadHarnessPlan(root: string, envRecipe: Record<string, unknown> | null | undefined): Promise<HarnessPlan> {
  let rootFiles: string[] = [];
  try {
    rootFiles = await fs.readdir(root);
  } catch {
    /* prázdný plán */
  }
  let scripts: Record<string, string> = {};
  let packageManagerField: string | null = null;
  try {
    const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: unknown;
    };
    scripts = pkg.scripts ?? {};
    packageManagerField = typeof pkg.packageManager === "string" ? pkg.packageManager : null;
  } catch {
    /* repo bez package.json */
  }
  const workflowRuns: string[] = [];
  try {
    const dir = join(root, ".github", "workflows");
    for (const f of (await fs.readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      workflowRuns.push(...extractWorkflowRunCommands(await fs.readFile(join(dir, f), "utf8")));
    }
  } catch {
    /* repo bez workflow */
  }
  return deriveHarnessPlan({ rootFiles, packageManagerField, scripts, workflowRuns, envRecipe });
}

async function baselineHarness(
  project: typeof projects.$inferSelect,
): Promise<(BaselineResult & { sha: string }) | null> {
  const sha = await mainHeadSha(project.id);
  if (!sha) return null;
  const key = `${project.id}:${sha}:${JSON.stringify(project.envRecipe ?? {})}`;
  let pending = baselineCache.get(key);
  if (!pending) {
    pending = withDetachedWorktree(project.id, sha, async (path) => {
      const plan = await loadHarnessPlan(path, project.envRecipe);
      const run = await runJudgeContainer({ workspaceHostPath: path, cmd: harnessScript(plan) });
      return { plan, run: parseHarnessOutput(run.stdout) };
    }).catch((err) => {
      console.error(`[judge] baseline nad main (${sha.slice(0, 8)}) selhala:`, redactSecrets(String(err)));
      return null;
    });
    baselineCache.set(key, pending);
    if (baselineCache.size > BASELINE_CACHE_MAX) {
      const oldest = baselineCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) baselineCache.delete(oldest);
    }
  }
  const res = await pending;
  if (!res || isHarnessRunBroken(res.run)) baselineCache.delete(key);
  return res ? { ...res, sha } : null;
}

async function runExistingHarness(
  project: typeof projects.$inferSelect,
  worktreePath: string,
): Promise<ExistingHarness> {
  const base = await baselineHarness(project);
  // Plán kontrol se bere z MAIN, ne z větve workera — worker si nesmí přepsat
  // harness, kterým je souzen (stejná zásada jako config ráčna). Bez baseline
  // (nešla změřit) z větve, ať se aspoň něco kontroluje.
  const plan = base?.plan ?? (await loadHarnessPlan(worktreePath, project.envRecipe));
  const run = await runJudgeContainer({ workspaceHostPath: worktreePath, cmd: harnessScript(plan) });
  const candidate = parseHarnessOutput(run.stdout);
  const baseline = base && !isHarnessRunBroken(base.run) ? base.run : null;
  const noOutput = HARNESS_CHECKS.every((c) => candidate.exits[c] === -1);
  // Vše červené u kandidáta, ale main je zdravý → rozbil to kandidát (reject),
  // ne infrastruktura. Porucha harnessu = žádný výstup, nebo červené i bez zdravé baseline.
  const broken = noOutput || (isHarnessRunBroken(candidate) && baseline === null);
  return {
    plan,
    candidate,
    baseline,
    baselineSha: base?.sha ?? null,
    newlyBroken: broken ? [] : newlyBrokenChecks(candidate, baseline),
    broken,
  };
}

/** Kolik rozbitých běhů harnessu po sobě zastaví schvalování v projektu. */
const HARNESS_BROKEN_AFTER = Math.max(1, Number(process.env.JUDGE_HARNESS_BROKEN_AFTER ?? 3));

/**
 * Fail-closed bez pádu orchestrátoru: když harness nejde spustit, posudek se
 * NEzapíše (žádný approve naslepo, žádný reject za cizí chybu) a judge zpráva se
 * vrátí do fronty s odstupem. Po HARNESS_BROKEN_AFTER bězích po sobě se zapíše
 * `judge_harness_broken` a odstup se prodlouží — každý další posudek v projektu
 * je pak zároveň sonda, a jakmile kontroly zase běží, schvalování se samo obnoví.
 * Vrací true, když byl posudek odložen.
 */
async function deferOnBrokenHarness(
  project: typeof projects.$inferSelect,
  task: typeof tasks.$inferSelect,
  message: JudgeMessage,
  harness: ExistingHarness,
): Promise<boolean> {
  const last = await getSql()<{ type: string; streak: number | null }[]>`
    SELECT type, (data->>'streak')::int AS streak FROM events
    WHERE project_id = ${project.id} AND type IN ('judge_harness_run_broken', 'judge_harness_ok')
    ORDER BY ts DESC LIMIT 1
  `;
  const prevStreak = last[0]?.type === "judge_harness_run_broken" ? (last[0].streak ?? 0) : 0;
  if (!harness.broken) {
    if (prevStreak > 0) {
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        type: "judge_harness_ok",
        message: "Kontroly projektu zase běží — farma obnovuje schvalování.",
        data: { previousStreak: prevStreak },
      });
    }
    return false;
  }
  const streak = prevStreak + 1;
  const stopped = streak >= HARNESS_BROKEN_AFTER;
  const delaySec = stopped ? 30 * 60 : 5 * 60;
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    level: "warn",
    type: "judge_harness_run_broken",
    message: `Kontroly projektu nešly spustit (${streak}× po sobě) — posudek odložen o ${Math.round(delaySec / 60)} min, hotová práce zůstává.`,
    data: { streak, install: harness.candidate.install, exits: harness.candidate.exits },
  });
  if (streak === HARNESS_BROKEN_AFTER) {
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "error",
      type: "judge_harness_broken",
      message: `Kontroly projektu ${streak}× po sobě nešly spustit — farma v projektu nic neschválí a každých 30 min je sama zkusí znovu.`,
      data: { streak },
    });
  }
  await enqueue(QUEUES.judge, message, delaySec);
  return true;
}

function harnessLogTail(harness: ExistingHarness): string {
  const parts = harness.newlyBroken
    .map((check) => {
      const log = harness.candidate.logs[check];
      return log ? `\n--- ${check} (konec logu) ---\n${log.slice(-800)}` : "";
    })
    .filter((s) => s.length > 0);
  return parts.join("");
}

/** Vytáhne exit kód z výstupu (řádek `NAME_EXIT=<n>`). Chybějící → -1. */
export function exitCode(stdout: string, marker: string): number {
  const m = stdout.match(new RegExp(`${marker}=(\\d+)`));
  return m && m[1] !== undefined ? Number(m[1]) : -1;
}
