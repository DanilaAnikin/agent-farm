/**
 * Tester agent (OVERVIEW §5.6) — headline feature farmy.
 *
 * q_qa consumer: pro každé přání, které judge označil za hotové (všechny tasky
 * done), spustí REÁLNOU end-to-end + vizuální verifikaci toho, co ostatní agenti
 * postavili:
 *   1) z merged mainu detekuje, jak se aplikace pouští (web server / cli / lib);
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
 *      re-enqueue do q_tasks (po N kolech přání zaparkuje pro člověka).
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
  wishes,
  projects,
  specs,
  QUEUES,
  enqueue,
  readOne,
  ackDelete,
} from "@farm/db";
import type { QaScenario, AcceptanceCriterion } from "@farm/db";
import { and, eq, desc } from "drizzle-orm";
import { loadConfig, wishMachine } from "@farm/core";
import {
  MODELS,
  structured,
  testerPlanPrompt,
  validateTesterPlan,
  visionCheckPrompt,
  validateVisionCheck,
} from "@farm/llm";
import type { TesterPlanOutput, VisionCheckOutput, ChatMessage } from "@farm/llm";
import { createStorage, assetPath } from "@farm/storage";
import { runAppAndTest } from "./docker.js";
import type { AppTestScenario, AppTestScenarioResult } from "./docker.js";
import { logEvent } from "./events.js";
import { registerAgent, releaseAgent } from "./agents-registry.js";
import { reflectOnFailure } from "./memory.js";
import type { QaMessage } from "./types.js";

/** Kolik scénářů maximálně vykonáme (strop nákladů a času). */
const MAX_SCENARIOS = 14;
/** Kolik screenshotů maximálně pošleme na vizuální kontrolu (strop nákladů). */
const MAX_VISION_CHECKS = 8;
/** Práh, nad kterým považujeme vizuální kontrolu za splněnou. */
const VISION_PASS_SCORE = 0.5;
/** Po kolika neúspěšných QA kolech přání zaparkujeme pro člověka. */
const MAX_QA_ROUNDS = 3;
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
    console.error(`[tester] QA přání ${message.wishId} selhalo:`, err);
    await logEvent({
      projectId: message.projectId,
      wishId: message.wishId,
      level: "error",
      type: "qa_error",
      message: `Tester selhal: ${String(err)}`,
    });
    // Zprávu odklidíme, ať nezacyklí; přání zůstane 'active' → vyřeší člověk/refill.
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

  // Registr flotily: Tester je 'busy' na tomto přání. (Role 'tester' v AGENT_ROLES
  // není — reuse role 'judge', model = manager, kterým Tester plánuje scénáře.)
  const agentId = await registerAgent({
    role: "judge",
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
  const workspacePath = join(cfg.workspacesRoot, project.id);

  // 1) Načti spec + acceptance criteria + strom souborů.
  const spec = await latestSpec(wish.id);
  const specMd = spec?.contentMd ?? wish.description ?? wish.title;
  const acceptanceCriteria: AcceptanceCriterion[] =
    spec?.acceptanceCriteria && spec.acceptanceCriteria.length > 0
      ? spec.acceptanceCriteria
      : [{ id: "c1", description: wish.title }];
  const fileTree = await buildFileTree(workspacePath);

  // 2) Detekuj, jak appku spustit.
  const runCfg = await detectRunConfig(workspacePath);

  // 3) Vygeneruj testovací scénáře (Tester plan).
  let planScenarios: TesterPlanOutput["scenarios"];
  try {
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
        fileTree,
      }),
      validate: validateTesterPlan,
      temperature: 0.2,
      metadata: { userId: project.userId, projectId: project.id, scope: "system" },
    });
    planScenarios = plan.data.scenarios.slice(0, MAX_SCENARIOS);
  } catch (err) {
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
    outputHostPath,
    scenarios: dockerScenarios,
    startCommand: hasWeb ? runCfg.startCommand : undefined,
    buildCommand: hasWeb ? runCfg.buildCommand : undefined,
    portCandidates: PORT_CANDIDATES,
    timeoutMs: QA_WALL_CLOCK_MS,
  });

  // Runner vůbec nedoběhl (kontejner spadl / timeout / žádné výsledky) → qa_error.
  if (!run.ok) {
    await failRunAsError(ctx, `Test-runner nedoběhl (${run.error ?? "neznámá chyba"}).`);
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

/** Zapíše qa_run jako 'error' a emitne qa_error (infra/model chyba, ne selhání appky). */
async function failRunAsError(ctx: QaContext, message: string): Promise<void> {
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

  // Preview deploy pro code/mixed projekty s repem (přes q_deploy — publisher
  // jako jediný drží Dokploy tokeny; žádný cross-app import).
  if (project.repoMode !== "none" && project.kind !== "content") {
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
    wishMachine.assert("active", "parked");
    await getDb().update(wishes).set({ status: "parked" }).where(eq(wishes.id, wish.id));
    await logEvent({
      projectId: project.id,
      wishId: wish.id,
      level: "warn",
      type: "wish_parked",
      message: `Přání „${wish.title}" zaparkováno — Tester ho neuzdravil ani po ${rounds} kolech. Vyžaduje člověka.`,
      data: { rounds },
    });
    // REFLEXE: co selhalo napříč koly → poučení do project_memory (self-healing brain).
    await reflectOnFailure({
      projectId: project.id,
      userId: project.userId,
      wishId: wish.id,
      taskTitle: `QA přání: ${wish.title}`,
      doneCondition: "Všechny QA scénáře přání musí projít v Testeru (funkčně i vizuálně).",
      failures: failed.map((s) => `${s.name} (${s.kind}): ${s.detail ?? "bez detailu"}`),
      evidence: `Tester zaparkoval přání po ${rounds} kolech. Selhaly scénáře: ${failed
        .map((s) => s.name)
        .join(", ")}.`,
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
}

/**
 * Detekuje z package.json, jak aplikaci spustit. Preferuje `dev` server
 * (rychlý start bez buildu); jinak build + start.
 */
async function detectRunConfig(workspacePath: string): Promise<RunConfig> {
  const pkg = await readPackageJson(workspacePath);
  if (!pkg) return {};
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const has = (name: string): boolean => {
    const s = scripts[name];
    return typeof s === "string" && s.length > 0;
  };

  if (has("dev")) return { startCommand: "pnpm run dev" };
  if (has("start") && has("build")) return { startCommand: "pnpm run start", buildCommand: "pnpm run build" };
  if (has("start")) return { startCommand: "pnpm run start" };
  if (has("preview") && has("build")) return { startCommand: "pnpm run preview", buildCommand: "pnpm run build" };
  if (has("serve")) return { startCommand: "pnpm run serve" };
  return {};
}

async function readPackageJson(
  workspacePath: string,
): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    const raw = await fs.readFile(join(workspacePath, "package.json"), "utf8");
    return JSON.parse(raw) as { scripts?: Record<string, string> };
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
