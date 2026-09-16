/**
 * Tester agent (OVERVIEW §5.6) — headline feature farmy.
 *
 * q_qa consumer: pro každé přání, které judge označil za hotové (všechny tasky
 * done), spustí REÁLNOU end-to-end + vizuální verifikaci toho, co ostatní agenti
 * postavili:
 *   1) ze schválených artifactů v izolovaném QA worktree detekuje, jak se aplikace pouští (web server / cli / lib);
 *   2) z spec + acceptance criteria vygeneruje konkrétní testovací scénáře
 *      (testerPlanPrompt, MODELS.manager) — cílem je POKRÝT VŠECHNA kritéria;
 *   3) v izolovaném gVisor kontejneru appku nastartuje a projede scénáře:
 *      web přes Playwright (klik/vyplň/čekej/screenshot), cli přes shell,
 *      api přes fetch;
 *   4) klíčové screenshoty pošle VLM (visionCheckPrompt, MODELS.mediaVlm), aby
 *      potvrdil, že to i VIZUÁLNĚ odpovídá kritériu;
 *   5) uloží screenshoty (storage + media_assets), spočítá pass/fail a zapíše
 *      qa_runs;
 *   6) PASS → uzavře přání (active → done) a zařadí preview deploy;
 *      FAIL → self-healing: pro každý selhaný scénář založí opravný task a
 *      re-enqueue do q_tasks (po N kolech přání přeplánuje z výsledků QA).
 *
 * U repo_mode='existing' se přání uzavírá až po potvrzeném sloučení všech PR
 * (úkoly jsou 'done' až po merge; navíc kontrola pr_opened bez pr_merged).
 * Chyba Testera (infrastruktura) se opakuje s exponenciálním odstupem v q_qa.
 *
 * Rozpočet: LLM volání jdou přes @farm/llm s metadata scope 'system'; počet
 * scénářů i vision volání je zastropovaný. Když aplikaci nejde vůbec spustit
 * (infra chyba runneru), zapíše qa_error a NEshodí smyčku.
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getDb,
  getSql,
  qaRuns,
  mediaAssets,
  tasks,
  attempts,
  reviews,
  wishes,
  projects,
  specs,
  QUEUES,
  enqueue,
  readOne,
  ackDelete,
} from "@farm/db";
import type { QaScenario, AcceptanceCriterion } from "@farm/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import {
  loadConfig,
  wishMachine,
  detectPackageManager,
  runScriptCommand,
  sanitizeRecipeEnv,
  validateRecipeCommand,
} from "@farm/core";
import {
  MODELS,
  structured,
  testerPlanPrompt,
  validateTesterPlan,
  visionCheckPrompt,
  validateVisionCheck,
  isLlmBudgetError,
} from "@farm/llm";
import type { TesterPlanOutput, VisionCheckOutput, ChatMessage } from "@farm/llm";
import { createStorage, assetPath } from "@farm/storage";
import { runAppAndTest } from "./docker.js";
import type { AppTestScenario, AppTestScenarioResult } from "./docker.js";
import { logEvent } from "./events.js";
import { registerAgent, releaseAgent } from "./agents-registry.js";
import { reflectOnFailure } from "./memory.js";
import type { QaMessage } from "./types.js";
import { prepareQaWorkspace, QaArtifactError, qaInfrastructureFailure } from "./qa-artifact.js";
import type { QaWorkspace, ReviewedQaArtifact } from "./qa-artifact.js";
import { withProjectRepoLock } from "./git.js";
import { groundQaCommands, applyGroundedQaCommands } from "./qa-command-grounding.js";
import { lastReplanAt, isSupersededTask } from "./dag.js";
import { replanWishOrPark } from "./judge.js";

/** Kolik scénářů maximálně vykonáme (strop nákladů a času). */
const MAX_SCENARIOS = 14;
/** Kolik screenshotů maximálně pošleme na vizuální kontrolu (strop nákladů). */
const MAX_VISION_CHECKS = 8;
/** Práh, nad kterým považujeme vizuální kontrolu za splněnou. */
const VISION_PASS_SCORE = 0.5;
/** Po kolika neúspěšných QA kolech farma přání přeplánuje z výsledků QA. */
const MAX_QA_ROUNDS = 3;
/** Kolikrát po sobě (za 48 h) se QA po chybě infrastruktury zopakuje, než se přání odloží. */
const MAX_QA_ERROR_RETRIES = Number(process.env.MAX_QA_ERROR_RETRIES ?? 6);
/** Kolik opravných tasků maximálně založíme za jedno kolo. */
const MAX_FIX_TASKS = 8;
/** Kandidátní porty, na kterých runner hledá běžící web server. */
const PORT_CANDIDATES = [3000, 5173, 4173, 8080, 5000, 3001, 8000, 4321];
/** Celkový wall-clock strop na jeden QA běh v kontejneru. */
const QA_WALL_CLOCK_MS = 10 * 60_000;

/** Jedna iterace QA loopu — vezme nejvýše jedno přání z q_qa. */
export async function runQaLoop(): Promise<void> {
  const msg = await readOne<QaMessage>(QUEUES.qa);
  if (!msg) return;
  const { message, msgId } = msg;

  try {
    await runQa(message);
    await ackDelete(QUEUES.qa, msgId);
  } catch (err) {
    if (isLlmBudgetError(err)) {
      await enqueue(QUEUES.qa, message, 3600);
      await ackDelete(QUEUES.qa, msgId);
      return;
    }
    console.error(`[tester] QA přání ${message.wishId} selhalo:`, err);
    await logEvent({
      projectId: message.projectId,
      wishId: message.wishId,
      level: "error",
      type: "qa_error",
      message: `Tester selhal: ${String(err)}`,
    });
    // Původní zprávu odklidíme (nezacyklí) a QA se zopakuje s odstupem — přání
    // nezůstane viset v 'active' bez toho, že by ho někdo znovu ověřil.
    await scheduleQaRetry(message.projectId, message.wishId, String(err)).catch((e) =>
      console.error("[tester] naplánování opakování QA selhalo:", e),
    );
    await ackDelete(QUEUES.qa, msgId);
  }
}

async function runQa(message: QaMessage): Promise<void> {
  const projRows = await getDb().select().from(projects).where(eq(projects.id, message.projectId)).limit(1);
  const project = projRows[0];
  if (!project) return;
  const wishRows = await getDb().select().from(wishes).where(eq(wishes.id, message.wishId)).limit(1);
  const wish = wishRows[0];
  if (!wish) return;
  // Přání už uzavřené/zaparkované → zastaralá zpráva, nic neděláme.
  if (wish.status !== "active") return;

  // Idempotence: pokud už jeden QA běh pro toto přání běží, tenhle přeskoč.
  const alreadyRunning = await getDb()
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(and(eq(qaRuns.wishId, wish.id), eq(qaRuns.status, "running")))
    .limit(1);
  if (alreadyRunning.length > 0) return;

  // Založ qa_run (status 'running').
  const insertedRun = await getDb()
    .insert(qaRuns)
    .values({ projectId: project.id, wishId: wish.id, taskId: message.taskId ?? null, status: "running" })
    .returning({ id: qaRuns.id });
  const qaRunId = insertedRun[0]?.id;
  if (!qaRunId) throw new Error("Nepodařilo se založit qa_run.");

  // Registr flotily: Tester je 'busy' na tomto přání. Vlastní role 'tester' — dřív
  // se registroval jako 'judge' a ve velíně se zobrazoval jako Soudce.
  const agentId = await registerAgent({
    role: "tester",
    projectId: project.id,
    model: MODELS.manager,
  });

  await logEvent({
    projectId: project.id,
    wishId: wish.id,
    type: "qa_started",
    message: `Tester spuštěn pro přání „${wish.title}".`,
    data: { qaRunId },
  });

  try {
    await executeQa({ project, wish, qaRunId });
  } finally {
    await releaseAgent(agentId);
  }
}

interface QaContext {
  project: typeof projects.$inferSelect;
  wish: typeof wishes.$inferSelect;
  qaRunId: string;
}

async function executeQa(ctx: QaContext): Promise<void> {
  const { project, wish, qaRunId } = ctx;
  const cfg = loadConfig();
  let workspace: QaWorkspace | undefined;
  try {
    // Úkoly nahrazené přeplánováním (zaparkované před posledním přeplánováním) se nepočítají.
    const replanAt = await lastReplanAt(wish.id);
    const wishTasks = (await getDb().select().from(tasks).where(eq(tasks.wishId, wish.id)))
      .filter((t) => !isSupersededTask(t, replanAt));
    if (wishTasks.length === 0 || wishTasks.some(t => t.status !== "done")) throw new QaArtifactError("wish_tasks_not_complete");
    const artifacts: ReviewedQaArtifact[] = [];
    if (project.repoMode === "existing") {
      // Přání se uzavírá až po SLOUČENÍ, ne po otevření PR.
      await assertPullRequestsMerged(wishTasks.map((t) => t.id));
      const codeTasks = wishTasks.filter(t => t.kind === "code");
      if (!codeTasks.length) throw new QaArtifactError("missing_code_artifacts");
      const approved = await getDb().select({ taskId: attempts.taskId, attemptId: attempts.id, branch: attempts.branch })
        .from(attempts).innerJoin(reviews, eq(reviews.attemptId, attempts.id))
        .where(and(inArray(attempts.taskId, codeTasks.map(t => t.id)), eq(attempts.status, "succeeded"),
          eq(attempts.isWinner, true), eq(reviews.verdict, "approve")))
        .orderBy(desc(attempts.finishedAt));
      for (const task of codeTasks) {
        const row = approved.find(a => a.taskId === task.id);
        if (!row?.branch) throw new QaArtifactError("task_missing_approved_artifact");
        artifacts.push({ taskId: task.id, attemptId: row.attemptId, branch: row.branch });
      }
    }
    workspace = await withProjectRepoLock(project.id, () => prepareQaWorkspace({
      workspacesRoot: cfg.workspacesRoot, projectId: project.id, qaRunId,
      existing: project.repoMode === "existing", artifacts,
      owner: process.env.LOCAL_RUNTIME === "1" ? undefined : { uid: 1001, gid: 1001 },
    }));
    const output = join(cfg.workspacesRoot, `${project.id}--qa`, qaRunId);
    await fs.mkdir(output, { recursive: true });
    const provenance = { qaRunId, commit: workspace.commit, artifacts: workspace.artifacts };
    await fs.writeFile(join(output, "artifact.json"), JSON.stringify(provenance, null, 2) + "\n");
    await logEvent({ projectId: project.id, wishId: wish.id, type: "qa_artifact_selected",
      message: "QA ověřuje izolovaný snapshot schválené práce.", data: provenance });
    await executeQaWorkspace(ctx, workspace.path, wishTasks);
  } catch (error) {
    if (isLlmBudgetError(error)) throw error;
    await failRunAsError(ctx, error instanceof QaArtifactError ? error.message : "QA infrastructure failed; reviewed artifacts were preserved.");
  } finally {
    if (workspace) await withProjectRepoLock(project.id, () => workspace!.cleanup()).catch(() => undefined);
  }
}

async function executeQaWorkspace(ctx: QaContext, workspacePath: string, wishTasks: (typeof tasks.$inferSelect)[]): Promise<void> {
  const { project, wish, qaRunId } = ctx;
  const cfg = loadConfig();

  // 1) Načti spec + acceptance criteria + strom souborů.
  const spec = await latestSpec(wish.id);
  const specMd = spec?.contentMd ?? wish.description ?? wish.title;
  const acceptanceCriteria: AcceptanceCriterion[] =
    spec?.acceptanceCriteria && spec.acceptanceCriteria.length > 0
      ? spec.acceptanceCriteria
      : [{ id: "c1", description: wish.title }];
  const fileTree = await buildFileTree(workspacePath);
  const grounding = await groundQaCommands({ workspacePath, criteria: acceptanceCriteria, tasks: wishTasks, hasSpec: !!spec });

  // 2) Detekuj, jak appku spustit (nejdřív podle ověřeného receptu projektu).
  const runCfg = await detectRunConfig(workspacePath, project.envRecipe);

  // 3) Vygeneruj testovací scénáře (Tester plan).
  let planScenarios: TesterPlanOutput["scenarios"];
  try {
    if (grounding.complete) {
      if (grounding.scenarios.length > MAX_SCENARIOS) throw new Error("QA verification exceeds the scenario limit.");
      planScenarios = grounding.scenarios;
    } else {
      const plan = await structured<TesterPlanOutput>({
        model: MODELS.manager,
        messages: testerPlanPrompt({
          wishTitle: wish.title,
          specMd,
          acceptanceCriteria: acceptanceCriteria.map((c) => ({
            id: c.id,
            description: c.description,
            check: c.check,
          })),
          projectKind: project.kind,
          startCommand: runCfg.startCommand,
          fileTree: `${fileTree}\n\n${grounding.promptContext}`,
        }),
        validate: validateTesterPlan,
        temperature: 0.2,
        metadata: { userId: project.userId, projectId: project.id, wishId: wish.id, scope: "system" },
      });
      planScenarios = applyGroundedQaCommands(plan.data.scenarios, grounding, MAX_SCENARIOS);
    }
  } catch (err) {
    if (isLlmBudgetError(err)) {
      // Opakování zařídí runQaLoop (odklad na obnovení rozpočtu), ne backoff chyb.
      await failRunAsError(ctx, "QA odloženo do obnovení rozpočtu.", { retry: false });
      throw err;
    }
    // Nepodařilo se naplánovat scénáře → infra/model chyba, ne selhání appky.
    await failRunAsError(ctx, `Nepodařilo se vygenerovat testovací scénáře: ${String(err)}`);
    return;
  }

  const hasWeb = planScenarios.some((s) => s.kind === "web");
  const dockerScenarios: AppTestScenario[] = planScenarios.map((s) => ({
    id: s.id,
    kind: s.kind,
    steps: s.steps,
    expect: s.expect,
    route: s.route,
  }));

  // 4) Spusť appku + projeď scénáře v izolovaném kontejneru.
  const outputHostPath = join(cfg.workspacesRoot, `${project.id}--qa`, qaRunId);
  const run = await runAppAndTest({
    workspaceHostPath: workspacePath,
    projectId: project.id,
    outputHostPath,
    scenarios: dockerScenarios,
    startCommand: hasWeb ? runCfg.startCommand : undefined,
    buildCommand: hasWeb ? runCfg.buildCommand : undefined,
    portCandidates: runCfg.portCandidates,
    timeoutMs: QA_WALL_CLOCK_MS,
    installCommand: runCfg.installCommand,
    env: runCfg.env,
  });

  const infrastructureFailure = qaInfrastructureFailure(run);
  if (infrastructureFailure) {
    await failRunAsError(ctx, infrastructureFailure);
    return;
  }

  // 5) Slož výsledky scénářů (funkční + vizuální) a ulož screenshoty.
  const resultById = new Map<string, AppTestScenarioResult>();
  for (const r of run.results) resultById.set(r.id, r);

  const storage = createStorage();
  const scenarios: QaScenario[] = [];
  const screenshotAssetIds: string[] = [];
  let visionUsed = 0;

  for (const plan of planScenarios) {
    const res = resultById.get(plan.id);
    let passed = res?.passed === true;
    let detail = res?.detail ?? "scénář se nevykonal";
    let screenshotPath: string | undefined;
    let visionScore: number | undefined;

    // Screenshot (jen web) → storage + media_assets + volitelně vizuální kontrola.
    if (res?.screenshotFile) {
      const pngBuf = await readScreenshot(outputHostPath, res.screenshotFile);
      if (pngBuf) {
        const assetId = randomUUID();
        const path = assetPath({ userId: project.userId, projectId: project.id, assetId, ext: "png" });
        try {
          await storage.put(path, pngBuf, "image/png");
          await getDb().insert(mediaAssets).values({
            id: assetId,
            projectId: project.id,
            wishId: wish.id,
            kind: "screenshot",
            storagePath: path,
            mime: "image/png",
            sizeBytes: pngBuf.length,
            status: "generated",
            meta: { scenario: plan.name, criterionId: plan.criterionId ?? null, qaRunId },
          });
          screenshotPath = path;
          screenshotAssetIds.push(assetId);
        } catch (err) {
          console.error("[tester] uložení screenshotu selhalo:", err);
        }

        // Vizuální kontrola (VLM) — jen pro funkčně OK screenshoty, do stropu.
        if (passed && visionUsed < MAX_VISION_CHECKS) {
          visionUsed++;
          const criterion = acceptanceCriteria.find((c) => c.id === plan.criterionId)?.description;
          const vision = await visionCheck(pngBuf, plan.name + ": " + plan.expect, criterion, project);
          if (vision) {
            visionScore = vision.score;
            const visualOk = vision.pass && vision.score >= VISION_PASS_SCORE;
            if (!visualOk) {
              passed = false;
              const issues = vision.issues?.length ? ` (${vision.issues.slice(0, 3).join("; ")})` : "";
              detail = `${detail}; vizuální kontrola selhala${issues}`;
            }
          }
        }
      }
    }

    scenarios.push({
      id: plan.id,
      name: plan.name,
      kind: plan.kind,
      criterionId: plan.criterionId,
      passed,
      detail,
      screenshotPath,
      visionScore,
    });
  }

  // 6) Celkový verdikt.
  const failed = scenarios.filter((s) => !s.passed);
  const overallPassed = scenarios.length > 0 && failed.length === 0;
  const coveredCriteria = new Set(scenarios.filter((s) => s.criterionId).map((s) => s.criterionId));
  const summary = overallPassed
    ? `Tester ověřil ${scenarios.length} scénářů (${coveredCriteria.size} kritérií) — vše prošlo funkčně i vizuálně.`
    : `Tester: ${failed.length} z ${scenarios.length} scénářů selhalo — ${failed
        .map((s) => s.name)
        .slice(0, 4)
        .join(", ")}${failed.length > 4 ? "…" : ""}.`;

  await getDb()
    .update(qaRuns)
    .set({
      status: overallPassed ? "passed" : "failed",
      passed: overallPassed,
      scenarios,
      summary,
      screenshotAssetIds,
      appUrl: run.appUrl ?? null,
      finishedAt: new Date(),
    })
    .where(eq(qaRuns.id, qaRunId));

  if (overallPassed) {
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      type: "qa_passed",
      message: summary,
      data: { qaRunId, summary, scenarioCount: scenarios.length },
    });
    await completeWish(ctx);
  } else {
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      level: "warn",
      type: "qa_failed",
      message: summary,
      data: { qaRunId, summary, failedCount: failed.length },
    });
    await selfHeal(ctx, failed);
  }
}

/**
 * Zapíše qa_run jako 'error' a emitne qa_error (infra/model chyba, ne selhání appky).
 * Standardně rovnou naplánuje opakování QA s exponenciálním odstupem.
 */
async function failRunAsError(ctx: QaContext, message: string, opts: { retry?: boolean } = {}): Promise<void> {
  await getDb()
    .update(qaRuns)
    .set({ status: "error", passed: false, summary: message, finishedAt: new Date() })
    .where(eq(qaRuns.id, ctx.qaRunId));
  await logEvent({
    projectId: ctx.project.id,
    wishId: ctx.wish.id,
    level: "error",
    type: "qa_error",
    message,
    data: { qaRunId: ctx.qaRunId },
  });
  if (opts.retry !== false) await scheduleQaRetry(ctx.project.id, ctx.wish.id, message);
}

/**
 * Chyba Testera → zpět do q_qa s exponenciálním odstupem (2, 4, 8 … min, strop 4 h).
 * Tvrdý limit MAX_QA_ERROR_RETRIES kol za 48 h; pak se přání odloží, aby opakované
 * spouštění nepálilo rozpočet — kód je u existujícího repa v té chvíli už sloučený.
 */
async function scheduleQaRetry(projectId: string, wishId: string, reason: string): Promise<void> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM events
    WHERE wish_id = ${wishId} AND type = 'qa_retry_scheduled' AND ts >= now() - interval '48 hours'
  `;
  const round = (rows[0]?.n ?? 0) + 1;
  if (round > MAX_QA_ERROR_RETRIES) {
    wishMachine.assert("active", "parked");
    const parked = await getDb()
      .update(wishes)
      .set({ status: "parked" })
      .where(and(eq(wishes.id, wishId), eq(wishes.status, "active")))
      .returning({ id: wishes.id });
    if (parked.length === 0) return;
    await logEvent({
      projectId,
      wishId,
      level: "warn",
      type: "wish_parked",
      message: `Tester ani po ${MAX_QA_ERROR_RETRIES} opakováních nešel spustit (${reason.slice(0, 160)}) — farma přání odkládá, aby nepálila rozpočet, a pokračuje jinou prací projektu.`,
      data: { rounds: MAX_QA_ERROR_RETRIES, cause: "qa_error" },
    });
    return;
  }
  const delaySec = Math.min(4 * 60 * 60, 120 * 2 ** (round - 1));
  const retry: QaMessage = { projectId, wishId };
  await enqueue(QUEUES.qa, retry, delaySec);
  await logEvent({
    projectId,
    wishId,
    level: "warn",
    type: "qa_retry_scheduled",
    message: `Tester selhal (${reason.slice(0, 160)}) — farma QA sama zopakuje za ${Math.round(delaySec / 60)} min (kolo ${round}/${MAX_QA_ERROR_RETRIES}).`,
    data: { round, delaySec },
  });
}

/**
 * U existujícího repa smí QA přání uzavřít jen tehdy, když je každý otevřený PR
 * úkolů přání potvrzeně sloučený (pr_opened bez pr_merged = ještě nedoručeno).
 */
async function assertPullRequestsMerged(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const sql = getSql();
  const rows = await sql<{ n: number }[]>`
    SELECT count(DISTINCT o.task_id)::int AS n FROM events o
    WHERE o.type = 'pr_opened' AND o.task_id IN ${sql(taskIds)}
      AND NOT EXISTS (SELECT 1 FROM events m WHERE m.type = 'pr_merged' AND m.task_id = o.task_id)
  `;
  if ((rows[0]?.n ?? 0) > 0) throw new QaArtifactError("pull_requests_not_merged");
}

/** PASS → uzavře přání (active → done) a zařadí preview deploy pro kód. */
async function completeWish(ctx: QaContext): Promise<void> {
  const { project, wish } = ctx;
  // Znovu načti přání (mohlo se mezitím změnit) — přechod jen z 'active'.
  const rows = await getDb().select({ status: wishes.status }).from(wishes).where(eq(wishes.id, wish.id)).limit(1);
  if (rows[0]?.status !== "active") return;

  wishMachine.assert("active", "done");
  await getDb().update(wishes).set({ status: "done" }).where(eq(wishes.id, wish.id));
  await logEvent({
    projectId: project.id,
    wishId: wish.id,
    type: "wish_done",
    message: `Přání splněno a ověřeno Testerem: ${wish.title}`,
  });

  // Existing repositories were verified on PR artifacts; their main is not this result.
  // Preview deploy pro nová code/mixed repa (přes q_deploy — publisher
  // jako jediný drží Dokploy tokeny; žádný cross-app import).
  if (project.repoMode === "new" && project.kind !== "content") {
    await enqueue(QUEUES.deploy, { projectId: project.id, wishId: wish.id, kind: "preview" });
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      type: "deploy_preview_enqueued",
      message: "Preview deploy zařazen do fronty.",
    });
  }
}

/**
 * FAIL → self-healing. Spočítá dosavadní neúspěšná QA kola (z events); po
 * MAX_QA_ROUNDS přání zaparkuje pro člověka. Jinak pro každý selhaný scénář
 * založí opravný task (kind 'code') a re-enqueue do q_tasks (přání zůstává active).
 */
async function selfHeal(ctx: QaContext, failed: QaScenario[]): Promise<void> {
  const { project, wish } = ctx;

  // Kolik krát už QA pro toto přání selhalo (včetně právě emitnutého qa_failed).
  const rounds = await countQaFailedRounds(wish.id);
  if (rounds >= MAX_QA_ROUNDS) {
    // REFLEXE PRVNÍ: poučení z výsledků QA musí být v project_memory dřív, než
    // plánovač přání přeplánuje — nová specifikace a plán z něj vychází.
    await reflectOnFailure({
      projectId: project.id,
      userId: project.userId,
      wishId: wish.id,
      taskTitle: `QA přání: ${wish.title}`,
      doneCondition: "Všechny QA scénáře přání musí projít v Testeru (funkčně i vizuálně).",
      failures: failed.map((s) => `${s.name} (${s.kind}): ${s.detail ?? "bez detailu"}`),
      evidence: `Tester přání neuzdravil ani po ${rounds} kolech. Selhaly scénáře: ${failed
        .map((s) => s.name)
        .join(", ")}.`,
    });
    // Vyčerpané QA → přeplánovat přání z výsledků QA (s tvrdým limitem kol).
    await replanWishOrPark({
      wishId: wish.id,
      project,
      cause: "qa_exhausted",
      leftoverParkReason: "qa_false_fix",
      summary: `Tester ho neuzdravil ani po ${rounds} kolech (selhalo: ${failed
        .map((s) => s.name)
        .slice(0, 4)
        .join(", ")})`,
    });
    return;
  }

  let created = 0;
  for (const sc of failed.slice(0, MAX_FIX_TASKS)) {
    const dedupKey = `qa-fix:${sc.id}`;
    // Neduplikuj otevřený fix task pro stejný scénář.
    const openTask = await getDb()
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.wishId, wish.id), eq(tasks.dedupKey, dedupKey)))
      .limit(1);
    const existing = openTask[0];
    if (existing) {
      // Existuje už fix task pro tento scénář → NIKDY neduplikuj. Jen ho znovu
      // zařaď, pokud je v znovuspustitelném stavu (queued/failed). running/judging
      // = už se pracuje; done/parked = necháváme na MAX_QA_ROUNDS / člověku.
      const st = await getDb().select({ status: tasks.status }).from(tasks).where(eq(tasks.id, existing.id)).limit(1);
      const status = st[0]?.status;
      if (status === "queued" || status === "failed") {
        if (status === "failed") {
          await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, existing.id));
        }
        await enqueue(QUEUES.tasks, {
          taskId: existing.id,
          projectId: project.id,
          wishId: wish.id,
          kind: "code",
          isFix: true,
          note: `QA znovu selhalo: ${sc.name} — ${sc.detail ?? ""}`,
        });
        created++;
      }
      continue;
    }

    const criterionNote = sc.criterionId ? ` (acceptance kritérium ${sc.criterionId})` : "";
    const title = `Oprava QA: ${sc.name}`.slice(0, 200);
    const doneCondition =
      `Scénář „${sc.name}" (${sc.kind})${criterionNote} musí projít v Testeru. ` +
      `Poslední selhání: ${sc.detail ?? "neznámé"}. ` +
      `Ověření: Tester znovu spustí aplikaci a projede tento scénář — musí projít funkčně i vizuálně.`;

    const inserted = await getDb()
      .insert(tasks)
      .values({
        projectId: project.id,
        wishId: wish.id,
        kind: "code",
        title,
        description: `Automaticky založeno Testerem po selhání QA scénáře „${sc.name}".`,
        doneCondition,
        status: "queued",
        dedupKey,
      })
      .returning({ id: tasks.id });
    const taskId = inserted[0]?.id;
    if (!taskId) continue;

    await enqueue(QUEUES.tasks, {
      taskId,
      projectId: project.id,
      wishId: wish.id,
      kind: "code",
      isFix: true,
      note: `QA selhalo: ${sc.name} — ${sc.detail ?? ""}`,
    });
    created++;
  }

  await logEvent({
    projectId: project.id,
    wishId: wish.id,
    type: "qa_fix_tasks",
    message: `Tester založil ${created} opravných úkolů (self-healing, kolo ${rounds}).`,
    data: { count: created },
  });
}

/** Počet 'qa_failed' událostí pro přání (kolik kol QA už selhalo). */
async function countQaFailedRounds(wishId: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM events
    WHERE wish_id = ${wishId} AND type = 'qa_failed'
  `;
  return rows[0]?.n ?? 0;
}

/** Vizuální kontrola screenshotu VLM modelem. Chyby polkne (vrátí null). */
async function visionCheck(
  pngBuf: Buffer,
  intent: string,
  criterion: string | undefined,
  project: typeof projects.$inferSelect,
): Promise<VisionCheckOutput | null> {
  try {
    // Screenshot jako data: URL → přiloží se jako multimodální obrázek (VLM ho reálně vidí).
    const messages = visionCheckPrompt({
      intent,
      criterion,
      imageUrl: `data:image/png;base64,${pngBuf.toString("base64")}`,
    });
    const res = await structured<VisionCheckOutput>({
      model: MODELS.mediaVlm,
      messages,
      validate: validateVisionCheck,
      temperature: 0,
      metadata: { userId: project.userId, projectId: project.id, scope: "system" },
    });
    return res.data;
  } catch (err) {
    if (isLlmBudgetError(err)) throw err;
    console.error("[tester] vizuální kontrola selhala (pokračuji bez ní):", err);
    return null;
  }
}

/** Přečte screenshot z host-mountnutého /out; null, když chybí. */
async function readScreenshot(outputHostPath: string, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(join(outputHostPath, file));
  } catch {
    return null;
  }
}

async function latestSpec(wishId: string): Promise<typeof specs.$inferSelect | undefined> {
  const rows = await getDb()
    .select()
    .from(specs)
    .where(eq(specs.wishId, wishId))
    .orderBy(desc(specs.version))
    .limit(1);
  return rows[0];
}

interface RunConfig {
  startCommand?: string;
  buildCommand?: string;
  /** Jak nainstalovat závislosti uvnitř QA kontejneru. */
  installCommand?: string;
  /** Bezpečné placeholdery prostředí z receptu (nikdy produkční tajemství). */
  env?: Record<string, string>;
  /** Porty, na kterých runner hledá běžící server (port z receptu první). */
  portCandidates: number[];
}

/** Příkaz z receptu použij jen tehdy, když projde bezpečnostní bránou. */
function recipeCommand(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const command = value.trim();
  return validateRecipeCommand(command).ok ? command : undefined;
}

/**
 * Jak aplikaci spustit.
 *
 * PRVNÍ se ptáme na recept projektu (projects.env_recipe) — ten farma sama
 * zjistila průzkumem repozitáře a OVĚŘILA reálným během v sandboxu. Teprve bez
 * receptu se odvozuje z package.json, ale správce balíčků se bere z lockfilu:
 * natvrdo `pnpm install` a `pnpm run dev` padalo u npm rep hned na instalaci
 * („QA dependency installation failed" → qa_error → zaparkované přání).
 */
async function detectRunConfig(
  workspacePath: string,
  envRecipe?: Record<string, unknown> | null,
): Promise<RunConfig> {
  const recipe = (envRecipe ?? {}) as Record<string, unknown>;
  const env = sanitizeRecipeEnv(recipe.env);
  const port = Number(recipe.port);
  const usePort = Number.isInteger(port) && port >= 80 && port <= 65535;
  const base: RunConfig = {
    portCandidates: usePort ? [port, ...PORT_CANDIDATES.filter((p) => p !== port)] : [...PORT_CANDIDATES],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  const pkg = await readPackageJson(workspacePath);
  const rootFiles = await fs.readdir(workspacePath).catch(() => [] as string[]);
  const pm =
    detectPackageManager(rootFiles, typeof pkg?.packageManager === "string" ? pkg.packageManager : null) ?? "pnpm";
  // QA potřebuje i devDependencies a lifecycle skripty, proto prostá instalace
  // (ne `--frozen-lockfile --ignore-scripts` jako u kontrol soudce).
  base.installCommand = recipeCommand(recipe.install) ?? (pm === "npm" ? "npm install" : `${pm} install`);

  const recipeStart = recipeCommand(recipe.start);
  if (recipeStart) {
    const recipeBuild = recipeCommand(recipe.start_build);
    return { ...base, startCommand: recipeStart, ...(recipeBuild ? { buildCommand: recipeBuild } : {}) };
  }

  if (!pkg) return base;
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const has = (name: string): boolean => {
    const s = scripts[name];
    return typeof s === "string" && s.length > 0;
  };
  const run = (name: string): string => runScriptCommand(pm, name);

  if (has("dev")) return { ...base, startCommand: run("dev") };
  if (has("start") && has("build")) return { ...base, startCommand: run("start"), buildCommand: run("build") };
  if (has("start")) return { ...base, startCommand: run("start") };
  if (has("preview") && has("build")) return { ...base, startCommand: run("preview"), buildCommand: run("build") };
  if (has("serve")) return { ...base, startCommand: run("serve") };
  return base;
}

async function readPackageJson(
  workspacePath: string,
): Promise<{ scripts?: Record<string, string>; packageManager?: unknown } | null> {
  try {
    const raw = await fs.readFile(join(workspacePath, "package.json"), "utf8");
    return JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: unknown };
  } catch {
    return null;
  }
}

/** Sestaví zkrácený strom souborů projektu (pro plán scénářů / routy). */
async function buildFileTree(root: string): Promise<string> {
  const SKIP = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", "coverage", ".cache"]);
  const MAX = 250;
  const out: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= MAX || depth > 5) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") {
        if (SKIP.has(e.name)) continue;
      }
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${childRel}/`);
        await walk(join(dir, e.name), childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  }

  await walk(root, "", 0);
  return out.join("\n");
}
