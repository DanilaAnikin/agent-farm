/**
 * Reconciliation (crash recovery) — při startu a pak každých 5 min (OVERVIEW §5.2).
 *  - attempts `running` s mrtvým heartbeatem (> 3 min), jejichž task se aktivně
 *    zpracovává (task.status='running') → attempt `failed` a task zpět do fronty
 *    BEZ inkrementu attempts_count (infra kill se férově nepočítá);
 *  - orphaned worker kontejnery (bez běžícího attemptu projektu) → kill;
 *  - prune stale worktrees.
 *
 * Attempty s task.status='judging' přeskakujeme — tam je pokus legitimně „running"
 * a čeká na judge (jehož build/test může trvat déle než heartbeat práh).
 */
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { getDb, getSql, tasks, attempts, projects, QUEUES, enqueue } from "@farm/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { loadConfig, isStaleHeartbeat } from "@farm/core";
import { logEvent } from "./events.js";
import { listWorkerContainers, killContainer } from "./docker.js";
import { markStaleAgents, reapDeadAgents, liveContainerIds } from "./agents-registry.js";
import { publishRuntimeConfig, publishGithubStatus } from "./runtime-config.js";
import type { TaskMessage } from "./types.js";
import { recoverOrphanedJudging } from "./judging-recovery.js";

const STALE_MS = Number(process.env.ATTEMPT_STALE_HEARTBEAT_MS ?? 3 * 60_000);
// 'queued' task bez zpracování déle než tohle = ztracená/chybějící zpráva (nebo
// dashboard retry, který pgmq neumí) → znovu zařadit. Kratší než recon interval.
// 10 min, ne 60 s: při MAX_WORKERS_TOTAL se dispatch vrací BEZ doteku tasku, takže
// legitimní čekání ve frontě je běžně delší než minuta a task se tvářil jako osiřelý.
const QUEUED_STALE_MS = Number(process.env.QUEUED_STALE_MS ?? 10 * 60_000);
// 'judging' task uvázlý (ztracená judge zpráva) — delší práh, judge build/test trvá.
const JUDGING_STALE_MS = Number(process.env.JUDGING_STALE_MS ?? 15 * 60_000);
// Jak dlouho držet 'dead' řádky agentů jako stopu, než se smažou.
const DEAD_AGENT_RETENTION_HOURS = 24;
// GitHub se ověřuje nejvýš jednou za hodinu (GET /user) — stav se mění zřídka
// a zbytečné volání API by jen pálilo rate limit.
const GITHUB_STATUS_EVERY_MS = 60 * 60_000;
let lastGithubStatusAt = 0;

async function maybePublishGithubStatus(): Promise<void> {
  const now = Date.now();
  if (now - lastGithubStatusAt < GITHUB_STATUS_EVERY_MS) return;
  // Značka PŘED voláním: i neúspěch se zkusí až za hodinu, ne každých 5 min.
  lastGithubStatusAt = now;
  await publishGithubStatus();
}

/** Jedna iterace reconciliation. Bezpečné volat i při startu. Každý krok je
 *  IZOLOVANÝ (vlastní try/catch) — selhání jednoho nesmí přeskočit ostatní
 *  (jinak by např. chyba v jednom kroku vypnula úklid kontejnerů/agentů/worktree). */
export async function runReconciliationOnce(): Promise<void> {
  for (const step of [
    reconcileStaleAttempts,
    reconcileStrandedRunning,
    reconcileOrphanedTasks,
    reconcileOrphanContainers,
    () => markStaleAgents(STALE_MS),
    () => reapDeadAgents(DEAD_AGENT_RETENTION_HOURS),
    pruneWorktrees,
    // Pravda o běžícím procesu pro dashboard. Tahle smyčka NENÍ pausable, takže
    // údaje jsou čerstvé i ve chvíli, kdy farma stojí.
    publishRuntimeConfig,
    maybePublishGithubStatus,
  ]) {
    try {
      await step();
    } catch (err) {
      console.error("[reconciliation] krok selhal (pokračuji dalším):", err);
    }
  }
}

/**
 * RECOVERY osiřelých tasků (jinak by farma tiše uvázla):
 *  - 'queued' bez živé zprávy (dashboard retry / ztracená zpráva), jejichž VŠECHNY
 *    závislosti jsou 'done' → znovu do q_tasks (dispatch je idempotentní, případné
 *    zdvojení zprávy je neškodné — druhá se jen zahodí);
 *  - 'judging' uvázlé (ztracená judge zpráva / crash mezi set 'judging' a enqueue)
 *    → obnovit judge pro stejný hotový pokus. Delayed/invisible zpráva není osiřelá;
 *    chybějící provenance se parkuje, nikdy nespouští čerstvě placený worker.
 */
async function reconcileOrphanedTasks(): Promise<void> {
  const sql = getSql();

  const queued = await sql<
    { id: string; project_id: string; wish_id: string | null; kind: string; note: string | null }[]
  >`
    SELECT t.id, t.project_id, t.wish_id, t.kind,
           (SELECT e.data->>'retry_note' FROM events e
             WHERE e.task_id = t.id AND e.type = 'task_retry'
             ORDER BY e.ts DESC LIMIT 1) AS note
    FROM tasks t
    WHERE t.status = 'queued'
      AND t.updated_at < now() - (${QUEUED_STALE_MS}::text || ' milliseconds')::interval
      AND NOT EXISTS (
        -- depends_on je JSONB pole uuid stringu; pouzivame operator ? (element
        -- membership), NE = ANY(...) (to vyzaduje pg pole a v runtime hazi chybu).
        SELECT 1 FROM tasks d
        WHERE t.depends_on ? (d.id::text) AND d.status <> 'done'
      )
      -- KRITICKÉ: "osiřelý" = queued a BEZ živé zprávy ve frontě. Bez téhle
      -- podmínky (dřív chyběla, ačkoliv ji komentář sliboval) přidával každý
      -- běh DALŠÍ zprávu pro tentýž task: fronta narostla na 103 zpráv pro
      -- 4 tasky. A protože čítač infraRetries žije v payloadu zprávy, každý
      -- duplikát resetoval počítadlo → task se místo po 10 pokusech parkoval
      -- až po tisících (21 016 dispatch_error vs. 7 task_parked_infra).
      AND NOT EXISTS (
        SELECT 1 FROM pgmq.q_q_tasks q WHERE q.message->>'taskId' = t.id::text
      )
  `;
  for (const t of queued) {
    await enqueue(QUEUES.tasks, {
      taskId: t.id,
      projectId: t.project_id,
      wishId: t.wish_id,
      kind: t.kind as TaskMessage["kind"],
      isFix: true,
      note: t.note ?? "reconciliation_requeue_queued",
    });
    await logEvent({
      projectId: t.project_id,
      taskId: t.id,
      type: "reconciliation_requeue_queued",
      message: "Osiřelý 'queued' task znovu zařazen do fronty.",
    });
  }

  for (const recovery of await recoverOrphanedJudging(JUDGING_STALE_MS, sql)) {
    const restored = recovery.kind === "judge_restored";
    await logEvent({
      projectId: recovery.projectId,
      taskId: recovery.taskId,
      level: restored ? "info" : "warn",
      type: restored ? "reconciliation_restore_judge" : "reconciliation_judge_missing_artifact",
      message: restored
        ? "Chybějící judge zpráva obnovena pro stejný hotový pokus."
        : "Judge nemá obnovitelný pokus s branch/worktree; úkol zaparkován bez nového workera.",
      data: recovery.attemptId ? { attemptId: recovery.attemptId } : undefined,
    });
  }
}

// Task uvázlý v 'running' bez ŽIVÉHO workera (žádný běžící pokus se score IS NULL a
// čerstvým heartbeatem). Pokrývá: (a) best-of-N crash s osiřelými doskórovanými
// kandidáty / gap po doskórování všech před task→judging, (b) obecný single-candidate
// stranding. Generalizace, ne jen best-of-N. Běží PO reconcileStaleAttempts.
const RUNNING_STALE_MS = Number(process.env.RUNNING_STALE_MS ?? 5 * 60_000);
async function reconcileStrandedRunning(): Promise<void> {
  const sql = getSql();
  const rows = await sql<{ id: string; project_id: string; wish_id: string | null; kind: string }[]>`
    SELECT id, project_id, wish_id, kind FROM tasks t
    WHERE t.status = 'running'
      AND t.updated_at < now() - (${RUNNING_STALE_MS}::text || ' milliseconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM attempts a
        WHERE a.task_id = t.id AND a.status = 'running' AND a.score IS NULL
          AND a.heartbeat_at >= now() - (${STALE_MS}::text || ' milliseconds')::interval
      )
  `;
  for (const t of rows) {
    await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, t.id));
    await enqueue(QUEUES.tasks, {
      taskId: t.id,
      projectId: t.project_id,
      wishId: t.wish_id,
      kind: t.kind as TaskMessage["kind"],
      isFix: true,
      note: "reconciliation_requeue_stranded_running",
    });
    await logEvent({
      projectId: t.project_id,
      taskId: t.id,
      level: "warn",
      type: "reconciliation_requeue_running",
      message: "Task uvázlý v 'running' bez živého workera znovu zařazen do fronty.",
    });
  }
}

async function reconcileStaleAttempts(): Promise<void> {
  const now = new Date();
  // running attempty, jejichž task se aktivně zpracovává (ne judging).
  const rows = await getDb()
    .select({
      attemptId: attempts.id,
      heartbeatAt: attempts.heartbeatAt,
      taskId: attempts.taskId,
      taskStatus: tasks.status,
      projectId: tasks.projectId,
      wishId: tasks.wishId,
      kind: tasks.kind,
      startedAt: attempts.startedAt,
    })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    // score IS NULL: reapujeme jen POKUS, který právě běží (worker žije/nežije).
    // Best-of-N kandidát, který už doskóroval (score set, kontejner zabit), čeká na
    // VÝBĚR — ten NEreapovat (jinak race s běžícím dispatchBestOfN → duplicitní task).
    .where(and(eq(attempts.status, "running"), eq(tasks.status, "running"), isNull(attempts.score)));

  for (const r of rows) {
    // Ochrana pomalé setup fáze: dokud běží kratší dobu než práh (heartbeat se
    // ještě nemusel stihnout objevit — repo/worktree/kontejner start), NEreapuj.
    // Jinak by se živý task duplicitně dispatchoval podruhé.
    if (r.startedAt && now.getTime() - new Date(r.startedAt).getTime() < STALE_MS) continue;
    if (!isStaleHeartbeat(r.heartbeatAt, now, STALE_MS)) continue;

    // attempt running → failed (infra kill)
    await getDb()
      .update(attempts)
      .set({ status: "failed", finishedAt: now, outputSummary: "Reconciliation: mrtvý heartbeat." })
      .where(eq(attempts.id, r.attemptId));

    // task running → queued BEZ inkrementu attempts_count
    await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, r.taskId));
    const msg: TaskMessage = {
      taskId: r.taskId,
      projectId: r.projectId,
      wishId: r.wishId,
      kind: r.kind,
      note: "reconciliation_requeue",
    };
    await enqueue(QUEUES.tasks, msg);

    await logEvent({
      projectId: r.projectId,
      taskId: r.taskId,
      level: "warn",
      type: "reconciliation_requeue",
      message: "Mrtvý pokus uklizen, task znovu zařazen (bez penalizace).",
      data: { attemptId: r.attemptId },
    });
  }
}

async function reconcileOrphanContainers(): Promise<void> {
  let containers: { id: string; projectId: string }[];
  try {
    containers = await listWorkerContainers();
  } catch (err) {
    console.error("[reconciliation] výpis kontejnerů selhal:", err);
    return;
  }
  if (containers.length === 0) return;

  // Projekty s aktivně běžícím taskem (mají mít živý kontejner).
  const running = await getDb()
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.status, "running"));
  const activeProjects = new Set(running.map((r) => r.projectId));
  // Container id KONKRÉTNÍCH živých workerů — matchujeme přesně, ne jen podle
  // projektu (jinak leaklý kontejner přežije, když v projektu běží jiný task).
  const liveIds = await liveContainerIds();

  for (const c of containers) {
    if (liveIds.has(c.id)) continue; // přesně tenhle kontejner drží živý worker
    // Safety: když je registr živých containerů prázdný (transient chyba / start),
    // radši nkilluj jen kontejnery projektů BEZ běžícího tasku (čerstvě spawnutý
    // kontejner nemusí být ještě zaznamenaný).
    if (liveIds.size === 0 && c.projectId && activeProjects.has(c.projectId)) continue;
    await killContainer(c.id);
    await logEvent({
      projectId: c.projectId || null,
      level: "warn",
      type: "orphan_container_killed",
      message: `Osiřelý worker kontejner ukončen: ${c.id.slice(0, 12)}.`,
    });
  }
}

async function pruneWorktrees(): Promise<void> {
  const cfg = loadConfig();
  const projRows = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.status, ["active", "paused", "budget_hold"]));

  for (const p of projRows) {
    try {
      const git = simpleGit(join(cfg.workspacesRoot, p.id));
      await git.raw(["worktree", "prune"]);
    } catch {
      /* projekt nemusí mít workspace (ještě nezaložen) */
    }
  }
}
