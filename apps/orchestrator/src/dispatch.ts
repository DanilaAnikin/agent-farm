/**
 * Worker dispatch loop (OVERVIEW §5.2).
 * q_tasks → worker kontejner projektu → worktree/branch → fresh opencode session
 * s per-attempt LLM klíčem → SSE eventy (počítání kroků + heartbeat) →
 * commit worktree, update .farm/progress.md, kill, `attempts` řádek → q_judge.
 *
 * Idempotence: attempt se zakládá per (task_id, msg_id) — redelivery nevytvoří
 * duplikát (DB unique attempts_task_msg_uq). Infra abort (limit kroků / wall-clock)
 * NEinkrementuje attempts_count (task se jen re-enqueuje).
 */
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import {
  getDb,
  tasks,
  attempts,
  reviews,
  projects,
  QUEUES,
  enqueue,
  readOne,
  ackDelete,
  extendVt,
  getSql,
} from "@farm/db";
import { and, eq, desc, sql, isNull } from "drizzle-orm";
import { loadConfig, taskMachine, isWallClockExceeded, checkBudget } from "@farm/core";
import {
  CONSTITUTION,
  MODELS,
  estimateTaskDifficulty,
  mintEphemeralKey,
  revokeKey,
  routeWorkerModel,
} from "@farm/llm";
import { creditBalance } from "@farm/billing";
import { logEvent } from "./events.js";
import { spendSnapshot } from "./cost.js";
import { isGlobalPaused, getCaps } from "./settings.js";
import { ensureRepo, createWorktree, commitWorktree, removeWorktree, type DiffStat } from "./git.js";
import { spawnWorker, killContainer, runJudgeContainer } from "./docker.js";
import { scoreCandidate, JUDGE_CMD, exitCode } from "./judge.js";
import { registerAgent, heartbeatAgent, releaseAgent } from "./agents-registry.js";
import { createSession, prompt, subscribeEvents, abortSession } from "./opencode.js";
import { assembleBrief } from "./memory.js";
import { areDepsMet } from "./dag.js";
import type { OpencodeEvent } from "./opencode.js";
import type { TaskMessage, JudgeMessage } from "./types.js";

/** Jedna iterace dispatch loopu — vezme nejvýše jeden task z fronty. */
export async function runDispatchOnce(): Promise<void> {
  // Globální pauza: nečteme frontu vůbec (zprávy zůstanou netknuté).
  if (await isGlobalPaused()) return;

  const cfg = loadConfig();
  const msg = await readOne<TaskMessage>(QUEUES.tasks);
  if (!msg) return;

  const { message, msgId } = msg;
  const taskId = message.taskId;

  // Načti task; když neexistuje / není queued → zprávu zahoď (stale).
  const taskRows = await getDb().select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (!task) {
    await ackDelete(QUEUES.tasks, msgId);
    return;
  }
  if (task.status !== "queued") {
    // Už se zpracovává nebo je hotový/parked — duplicitní/zastaralá zpráva.
    await ackDelete(QUEUES.tasks, msgId);
    return;
  }

  // DAG pojistka: task se smí spustit teprve, když jsou VŠECHNY jeho závislosti
  // 'done'. Za normálních okolností se sem nezralý task nedostane (enqueujeme jen
  // kořeny + odblokované), ale kdyby přišel dřív, zprávu NEackujeme — ať se vrátí
  // (po vt) a spustí se, až budou závislosti splněné. Žádný spin: běžný případ 0 dep.
  if (!(await areDepsMet(task.dependsOn))) {
    await logEvent({
      projectId: task.projectId,
      taskId,
      type: "task_deps_pending",
      message: "Task ještě má nesplněné závislosti — odkládám dispatch.",
      data: { dependsOn: task.dependsOn },
    });
    return;
  }

  const projRows = await getDb().select().from(projects).where(eq(projects.id, task.projectId)).limit(1);
  const project = projRows[0];
  if (!project) {
    await ackDelete(QUEUES.tasks, msgId);
    return;
  }
  // Projekt musí být aktivní; jinak zprávu nezacházíme (znovu se objeví po vt).
  if (project.status !== "active") return;

  // --- Rozpočtová brána (před dispatchem) ---
  const caps = await getCaps(project.userId, project.id, task.wishId);
  const spend = await spendSnapshot(project.userId, project.id, task.wishId);
  const overscope = checkBudget(spend, caps, cfg.perAttemptBudgetUsd);
  if (overscope) {
    // Strop dosažen → projekt do budget_hold; zprávu NEackujeme (znovu po vt/resetu).
    // active → budget_hold (viz projectMachine).
    await getDb().update(projects).set({ status: "budget_hold" }).where(eq(projects.id, project.id));
    await logEvent({
      projectId: project.id,
      taskId,
      level: "warn",
      type: "budget_hold",
      message: `Projekt v budget_hold — překročen strop: ${overscope}.`,
      data: { scope: overscope },
    });
    return;
  }

  // --- Kreditní brána (měsíční příděl plánu + top-upy) ---
  const credit = await creditBalance(project.userId);
  if (!credit.ok) {
    await getDb().update(projects).set({ status: "budget_hold" }).where(eq(projects.id, project.id));
    await logEvent({
      projectId: project.id,
      taskId,
      level: "warn",
      type: "out_of_credits",
      message: `Projekt pozastaven — vyčerpány měsíční kredity (plán ${credit.planKey}). Navyš je v nastavení účtu.`,
      data: { remainingUsd: credit.remainingUsd, planKey: credit.planKey },
    });
    return;
  }

  // --- Souběžnost workerů (solo self-host: globální strop farmy, žádné plány) ---
  // Kolik pokusů právě běží napříč VŠEMI projekty? Na stropu zprávu NEackujeme —
  // vrátí se po vt a spustí, až se slot uvolní. Řízeno MAX_WORKERS_TOTAL.
  const workerCap = cfg.maxWorkersTotal;
  // Počítáme jen AKTIVNĚ BĚŽÍCÍ workery: attempt 'running' + task 'running' + score
  // IS NULL. Attempty ve fázi 'judging' i best-of-N kandidáti, kteří UŽ doskórovali
  // (score SET, kontejner zabit, čekají na výběr), slot už nedrží — jinak by jeden
  // best-of-N task nafoukl celý worker-cap uživatele a vyhladověl ostatní.
  const runningForUser = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.userId, project.userId),
        eq(attempts.status, "running"),
        eq(tasks.status, "running"),
        isNull(attempts.score),
      ),
    );
  if (Number(runningForUser[0]?.n ?? 0) >= workerCap) {
    await logEvent({
      projectId: project.id,
      taskId,
      type: "worker_cap_reached",
      message: `Dosažen globální strop souběžných workerů (${workerCap}) — odkládám dispatch.`,
      data: { workerCap },
    });
    return;
  }

  // --- Souběžnost workerů PER PROJEKT (projects.autonomy.maxParallelWorkers) ---
  // Volitelný per-projekt strop nad rámec plánového per-user capu: kolik workerů smí
  // běžet SOUČASNĚ na tomhle projektu (swarm paralelizace). undefined/0 = bez extra limitu.
  const projMaxWorkers = project.autonomy?.maxParallelWorkers;
  if (typeof projMaxWorkers === "number" && projMaxWorkers > 0) {
    const runningForProject = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(attempts)
      .innerJoin(tasks, eq(attempts.taskId, tasks.id))
      .where(
        and(
          eq(tasks.projectId, project.id),
          eq(attempts.status, "running"),
          eq(tasks.status, "running"),
          isNull(attempts.score),
        ),
      );
    if (Number(runningForProject[0]?.n ?? 0) >= projMaxWorkers) {
      await logEvent({
        projectId: project.id,
        taskId,
        type: "worker_cap_reached",
        message: `Dosažen per-projekt strop souběžných workerů (${projMaxWorkers}) — odkládám dispatch.`,
        data: { projectMaxWorkers: projMaxWorkers },
      });
      return;
    }
  }

  // --- Idempotence: existuje už attempt pro (task_id, msg_id)? ---
  const existing = await getDb()
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.taskId, taskId), eq(attempts.msgId, msgId)))
    .limit(1);
  if (existing.length > 0) {
    // Redelivery po dokončeném/probíhajícím pokusu — jen odklidit zprávu.
    await ackDelete(QUEUES.tasks, msgId);
    return;
  }

  await dispatchTask(task, project, msg.message, msgId);
}

interface TaskRow {
  id: string;
  projectId: string;
  wishId: string | null;
  title: string;
  description: string;
  doneCondition: string;
  status: string;
  attemptsCount: number;
}

interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  repoMode: "new" | "existing" | "none";
  repoUrl: string | null;
}

/**
 * Preferuje projekt silnější model? True, když levný `worker` model má v tomto
 * projektu na dostatečném vzorku nízkou úspěšnost (< 40 %) — pak nové tasky
 * začínají rovnou silněji. Defenzivní: při chybě/malém vzorku vrací false.
 */
async function projectPrefersStrongModel(projectId: string): Promise<boolean> {
  try {
    const rows = await getDb()
      .select({
        ok: sql<number>`count(*) filter (where ${attempts.status} = 'succeeded')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(attempts)
      .innerJoin(tasks, eq(attempts.taskId, tasks.id))
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(attempts.model, MODELS.worker),
          // JEN single-path pokusy (best-of-N kandidáti mají msgId `...#c<idx>` a
          // slabý kandidát #0 strukturálně prohrává výběr — nesmí kazit metriku).
          sql`${attempts.msgId} NOT LIKE '%#c%'`,
          // RECENCY okno (14 dní) — bez něj by se metrika zamkla natrvalo a projekt
          // by už nikdy nezkusil levný model, i kdyby teď uspěl.
          sql`${attempts.finishedAt} >= now() - interval '14 days'`,
        ),
      );
    const ok = Number(rows[0]?.ok ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    return total >= 5 && ok / total < 0.4;
  } catch (err) {
    console.error("[dispatch] projectPrefersStrongModel selhalo (fallback false):", err);
    return false;
  }
}

interface BestOfNCandidate {
  attemptId: string;
  candidateIdx: number;
  branch: string;
  worktreePath: string;
  score: number;
}

/**
 * BEST-OF-N (Návrh A, sekvenční): vygeneruje N soupeřících kandidátů na jeden task,
 * každý na vlastní izolované větvi, mechanicky je oskóruje (build/test/lint) a do
 * judge/merge cesty pošle JEN VÍTĚZE (nejvyšší score, tie → nejnižší idx). Poražené
 * zahodí. Merge fronta vidí přesně jednu branch/task jako u single cesty — invarianty
 * netknuté. `claim queued→running` proběhl JEDNOU u volajícího (dispatchTask).
 */
async function dispatchBestOfN(
  task: TaskRow,
  project: ProjectRow,
  requestedN: number,
  message: TaskMessage,
  msgId: string,
): Promise<void> {
  const cfg = loadConfig();
  const n = Math.min(Math.max(2, Math.floor(requestedN)), cfg.maxBestOfN);
  const isFix = message.isFix === true || task.attemptsCount > 0;
  // POZOR: pro DIVERZITU kandidátů použij ZÁKLADNÍ obtížnost (ne history 'hard'
  // override) — candidateIdx sám eskaluje tier (0→worker,1→worker-hard,…); přidání
  // 'hard' navrch by kandidáty srazilo na jeden model (collapse) a soupeření zmizí.
  const difficulty = estimateTaskDifficulty(`${task.title}\n${task.description}\n${task.doneCondition}`);

  // Pokrytí dlouhého PRVNÍHO klonu: bumpni updated_at těsně před ensureRepo, aby
  // reconcileStrandedRunning task (u kterého ještě neběží žádný attempt, protože klon
  // stále probíhá) nepovažoval za stranded a nevrátil ho do 'queued'. Bez toho by se
  // celý klon/setup zahodil a task by bouncoval. (Claim už bumpl přes $onUpdate; belt.)
  await getDb().update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, task.id));
  await ensureRepo(project);
  const candidates: BestOfNCandidate[] = [];
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    type: "best_of_n_started",
    message: `Best-of-${n}: generuji ${n} soupeřících kandidátů pro „${task.title}".`,
    data: { n },
  });

  for (let idx = 0; idx < n; idx++) {
    // R1 belt: prodluž viditelnost q_tasks zprávy (dlouhá smyčka ji nesmí vrátit).
    await extendVt(QUEUES.tasks, msgId, cfg.pgmqVisibilityTimeoutSec).catch(() => undefined);

    // Per-kandidát brána — N-násobný náklad nesmí přetéct kredity ANI scoped stropy
    // (denní/wish/project). Při překročení generování zastav a vyber z hotových.
    const credit = await creditBalance(project.userId);
    const scopedCaps = await getCaps(project.userId, project.id, task.wishId);
    const scopedSpend = await spendSnapshot(project.userId, project.id, task.wishId);
    const overBudget = checkBudget(scopedSpend, scopedCaps, cfg.perAttemptBudgetUsd);
    if (!credit.ok || overBudget) {
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "best_of_n_budget_stop",
        message: `Best-of-N zastaveno po ${idx} kandidátech — ${!credit.ok ? "vyčerpané kredity" : `strop: ${overBudget}`}; vybírám z hotových.`,
      });
      break;
    }

    // Recon guard: task musí být stále 'running'. Když ho recon mezitím vzal
    // (posun na 'queued'), čistě ukliď dosavadní kandidáty a skonči (bez enqueue judge).
    const cur = await getDb().select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id)).limit(1);
    if (cur[0]?.status !== "running") {
      await cleanupCandidates(project.id, candidates);
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "best_of_n_aborted",
        message: "Task už není 'running' (převzal reconciliation) — best-of-N ukončeno.",
      });
      return;
    }
    // Bump updated_at, ať reconcileStrandedRunning nepovažuje AKTIVNÍ best-of-N za stranded.
    await getDb().update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, task.id));

    const model = routeWorkerModel({ attempt: task.attemptsCount + 1, difficulty, candidateIdx: idx });
    const candMsgId = `${msgId}#c${idx}`; // syntetický msgId kvůli unique (task_id, msg_id)
    const inserted = await getDb()
      .insert(attempts)
      .values({ taskId: task.id, model, msgId: candMsgId, candidateIdx: idx, status: "running", heartbeatAt: new Date() })
      .returning({ id: attempts.id });
    const attemptId = inserted[0]?.id;
    if (!attemptId) continue;

    const agentId = await registerAgent({ role: "worker", projectId: project.id, model, currentTaskId: task.id });
    const key = await mintEphemeralKey({
      maxBudgetUsd: cfg.perAttemptBudgetUsd,
      duration: "35m",
      metadata: { userId: project.userId, taskId: task.id, projectId: project.id, attemptId, scope: "attempt" },
    });

    let containerId: string | null = null;
    let candBranch = "";
    let candWorktree = "";
    let candidateOk = false;
    const startedAt = Date.now();

    // Heartbeat MUSÍ tikat už od téhle chvíle, ne až od runWithLimits.
    // Mezi vložením řádku pokusu a spuštěním smyčky se stihne git worktree,
    // start kontejneru a čekání, než opencode server naběhne — u větších rep to
    // trvá minuty. Reconciliace přitom pokus bez heartbeatu starší 3 minut uzná
    // za mrtvý, zabije mu kontejner a task znovu zařadí; čekající fetch pak spadne
    // na "TypeError: fetch failed". Přesně tahle smyčka sežrala 202 z 204 selhání
    // a naparkovala 104 úkolů, které pak zablokovaly všechno, co na nich viselo.
    // Poznávací znak v datech: heartbeat_at == started_at a steps_used = 0.
    const setupHeartbeat = setInterval(() => {
      void touchHeartbeat(attemptId, 0).catch(() => undefined);
      void heartbeatAgent(agentId).catch(() => undefined);
    }, 30_000);

    try {
      const wt = await createWorktree(project.id, task.id, idx);
      candBranch = wt.branch;
      candWorktree = wt.worktreePath;
      await getDb().update(attempts).set({ branch: wt.branch, worktreeRef: wt.worktreePath }).where(eq(attempts.id, attemptId));
      const worker = await spawnWorker({ projectId: project.id, workspaceHostPath: wt.worktreePath });
      containerId = worker.containerId;
      await heartbeatAgent(agentId, { containerId });
      const session = await createSession(worker.baseUrl);
      await getDb().update(attempts).set({ opencodeSessionId: session.id }).where(eq(attempts.id, attemptId));
      const promptText = await buildPromptText(project.id, task, isFix, message.note);
      clearInterval(setupHeartbeat); // dál heartbeatuje runWithLimits
      const outcome = await runWithLimits({
        baseUrl: worker.baseUrl,
        sessionId: session.id,
        apiKey: key.key,
        agent: isFix ? "worker-fix" : "worker-build",
        model,
        text: promptText,
        attemptId,
        agentId,
        startedAt,
      });

      if (outcome.kind !== "ok") {
        // Kandidát selhal/abort → NEskórujeme (status failed/aborted, score zůstane
        // NULL → vyloučen z výběru). NErequeujeme celý task kvůli jednomu kandidátovi.
        await finalizeAttempt(
          attemptId,
          outcome.kind === "aborted" ? "aborted" : "failed",
          outcome.steps,
          startedAt,
          outcome.kind === "error" ? String(outcome.error) : outcome.text,
        );
        continue;
      }

      // KRITICKÉ: heartbeatuj pokus i během commit+prescore. runWithLimits svůj
      // heartbeat po návratu zastaví, ale commit + runJudgeContainer (build/test/lint)
      // trvá u reálného projektu i minuty. Bez čerstvého heartbeatu by reconciliation
      // (score IS NULL, task 'running') považovala živého kandidáta za mrtvého,
      // requeuenula task a jiný dispatch by ho vzal → double-dispatch/double-merge.
      const hb = setInterval(() => {
        void getDb().update(attempts).set({ heartbeatAt: new Date() }).where(eq(attempts.id, attemptId)).catch(() => undefined);
      }, 30_000);
      let score: number;
      let candDiffStat: DiffStat | null = null;
      try {
        const commitOut = await commitWorktree(wt.worktreePath, `farm: ${task.title}\n\nTask ${task.id}\n${task.doneCondition}`);
        candDiffStat = commitOut.diffStat;
        // Mechanické prescore (build/test/lint) — deterministické, bez LLM.
        const run = await runJudgeContainer({ workspaceHostPath: wt.worktreePath, cmd: JUDGE_CMD });
        score = scoreCandidate({
          buildOk: exitCode(run.stdout, "BUILD_EXIT") === 0,
          testsOk: exitCode(run.stdout, "TEST_EXIT") === 0,
          lintOk: exitCode(run.stdout, "LINT_EXIT") === 0,
        });
      } finally {
        clearInterval(hb);
      }
      // Pokus zůstává 'running' se score SET → recon ho NEreapuje (Patch 1) a čeká na výběr.
      await getDb()
        .update(attempts)
        .set({ score, stepsUsed: outcome.steps, wallMs: Date.now() - startedAt, outputSummary: outcome.text.slice(0, 8000), diffStat: candDiffStat ?? undefined, heartbeatAt: new Date() })
        .where(eq(attempts.id, attemptId));
      candidateOk = true;
      candidates.push({ attemptId, candidateIdx: idx, branch: wt.branch, worktreePath: wt.worktreePath, score });
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        type: "best_of_n_candidate",
        message: `Kandidát #${idx} (${model}) oskórován: ${score}.`,
        data: { candidateIdx: idx, score, model },
      });
    } catch (err) {
      await finalizeAttempt(attemptId, "failed", 0, startedAt, String(err)).catch(() => undefined);
      console.error(`[dispatch] best-of-N kandidát #${idx} selhal:`, err);
    } finally {
      // Bezpodmínečně: když příprava spadne (worktree, spawn, session), do
      // clearInterval na úspěšné cestě se nedojde a ticker by tikal navždy.
      clearInterval(setupHeartbeat);
      // Uvolni kandidátova workera/klíč/kontejner.
      await releaseAgent(agentId);
      await revokeKey(key.key).catch(() => undefined);
      if (containerId) await killContainer(containerId);
      // Worktree ÚSPĚŠNÉHO kandidáta NECHÁME (potřeba pro výběr/merge vítěze); worktree
      // NEúspěšného kandidáta uklidíme HNED (jinak leakuje — do `candidates` se nedostal).
      if (!candidateOk && candWorktree) await removeWorktree(project.id, candWorktree, candBranch);
    }
  }

  // Výběr vítěze: nejvyšší score, tie → nejnižší candidateIdx (stabilní pořadí vkládání).
  if (candidates.length === 0) {
    // Žádný validní kandidát → requeue bez penalizace (chráněno MAX_INFRA_RETRIES).
    await requeueNoPenalty(task, message, msgId, "best_of_n_no_candidate");
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      type: "best_of_n_no_winner",
      message: "Best-of-N: žádný kandidát nedokončil — task vrácen do fronty.",
    });
    return;
  }
  candidates.sort((a, b) => b.score - a.score || a.candidateIdx - b.candidateIdx);
  const winner = candidates[0]!;

  // Poražení → 'rejected' + úklid worktree/branch (pod repoLock v removeWorktree).
  for (const c of candidates) {
    if (c.attemptId === winner.attemptId) continue;
    await getDb().update(attempts).set({ status: "rejected", finishedAt: new Date() }).where(eq(attempts.id, c.attemptId));
    await removeWorktree(project.id, c.worktreePath, c.branch);
  }

  // Vítěz → NORMÁLNÍ judge/merge cesta (netknutá).
  const judgeMsg: JudgeMessage = {
    attemptId: winner.attemptId,
    taskId: task.id,
    projectId: project.id,
    wishId: task.wishId,
    branch: winner.branch,
    worktreeRef: winner.worktreePath,
  };
  // ATOMICKÝ handoff vítěze do judge: running→judging JEN když je task stále
  // 'running' (nikdo ho mezitím nepřevzal). Belt proti dvojímu mergi: kdyby snad
  // (přes recon requeue + reclaim) běžely dva best-of-N pro tentýž task, judge
  // enqueuuje jen ten, kdo vyhraje tuhle atomickou tranzici. Druhý ukliď vítěze a skonči.
  taskMachine.assert("running", "judging");
  const claimedJudging = await getDb()
    .update(tasks)
    .set({ status: "judging" })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "running")))
    .returning({ id: tasks.id });
  if (claimedJudging.length === 0) {
    await getDb()
      .update(attempts)
      .set({ status: "rejected", finishedAt: new Date() })
      .where(eq(attempts.id, winner.attemptId))
      .catch(() => undefined);
    await removeWorktree(project.id, winner.worktreePath, winner.branch);
    await ackDelete(QUEUES.tasks, msgId);
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      type: "best_of_n_lost_ownership",
      message: "Best-of-N: task mezitím převzal jiný dispatch — vítěz zahozen (bez dvojího merge).",
    });
    return;
  }
  await enqueue(QUEUES.judge, judgeMsg);
  await ackDelete(QUEUES.tasks, msgId);
  await logEvent({
    projectId: project.id,
    taskId: task.id,
    type: "best_of_n_winner",
    message: `Best-of-N vítěz: kandidát #${winner.candidateIdx} (score ${winner.score}) → judge. Poraženo: ${candidates.length - 1}.`,
    data: { winnerIdx: winner.candidateIdx, winnerScore: winner.score, candidates: candidates.length },
  });
}

/** Úklid rozdělaných kandidátů (recon-abort): rejected + odstraň worktree/branch. */
async function cleanupCandidates(projectId: string, candidates: BestOfNCandidate[]): Promise<void> {
  for (const c of candidates) {
    await getDb()
      .update(attempts)
      .set({ status: "rejected", finishedAt: new Date() })
      .where(eq(attempts.id, c.attemptId))
      .catch(() => undefined);
    await removeWorktree(projectId, c.worktreePath, c.branch);
  }
}

async function dispatchTask(
  taskRaw: typeof tasks.$inferSelect,
  projectRaw: typeof projects.$inferSelect,
  message: TaskMessage,
  msgId: string,
): Promise<void> {
  const cfg = loadConfig();
  const task: TaskRow = {
    id: taskRaw.id,
    projectId: taskRaw.projectId,
    wishId: taskRaw.wishId,
    title: taskRaw.title,
    description: taskRaw.description,
    doneCondition: taskRaw.doneCondition,
    status: taskRaw.status,
    attemptsCount: taskRaw.attemptsCount,
  };
  const project: ProjectRow = {
    id: projectRaw.id,
    userId: projectRaw.userId,
    name: projectRaw.name,
    repoMode: projectRaw.repoMode,
    repoUrl: projectRaw.repoUrl,
  };

  // queued → running ATOMICKY: podmínka status='queued' přímo v UPDATE, ať dva
  // souběžné dispatch loopy nezaberou stejný task (jinak kolize na worktree/branch).
  // Když řádek neupdatujeme, task mezitím vzal jiný loop → jen uklidíme zprávu.
  taskMachine.assert("queued", "running");
  const claimed = await getDb()
    .update(tasks)
    .set({ status: "running" })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")))
    .returning({ id: tasks.id });
  if (claimed.length === 0) {
    await ackDelete(QUEUES.tasks, msgId);
    return;
  }

  // BEST-OF-N: task s best_of_n>1 → vygeneruj N soupeřících kandidátů, vyber
  // nejlepšího a do judge/merge cesty pošli JEN vítěze (zbytek zahoď). Claim
  // queued→running proběhl JEDNOU výše (jeden task) — swarm-invariant netknutý.
  // Single cesta (best_of_n===1, 99 % provozu) pokračuje beze změny níže.
  if (taskRaw.bestOfN > 1) {
    await dispatchBestOfN(task, project, taskRaw.bestOfN, message, msgId);
    return;
  }

  // Založ attempt (idempotentně díky unique (task_id, msg_id)).
  const isFix = message.isFix === true || task.attemptsCount > 0;
  // ADAPTIVNÍ MODEL ROUTING: levný model na první pokus, eskalace při opakování
  // A podle obtížnosti úkolu (těžké téma/dlouhé zadání → rovnou silnější model).
  // attemptsCount je 0-based počet PŘEDCHOZÍCH pokusů; routeWorkerModel čeká
  // 1-based číslo pokusu → +1 (jinak by eskalace naskočila až o pokus později).
  const baseDifficulty = estimateTaskDifficulty(`${task.title}\n${task.description}\n${task.doneCondition}`);
  // HISTORIE PROJEKTU: když levný `worker` model v tomhle projektu opakovaně
  // selhává, začni rovnou silněji (méně promarněných levných pokusů). Adaptivní
  // signál z reálné úspěšnosti, ne jen z textu tasku.
  const difficulty =
    baseDifficulty !== "hard" && (await projectPrefersStrongModel(project.id)) ? "hard" : baseDifficulty;
  const model = routeWorkerModel({ attempt: task.attemptsCount + 1, difficulty });
  const insertedAttempt = await getDb()
    .insert(attempts)
    .values({
      taskId: task.id,
      model,
      msgId,
      status: "running",
      // Čerstvý heartbeat hned při založení — chrání pomalou setup fázi (repo/
      // worktree/kontejner start) před tím, aby ji reconciliation zabila jako mrtvou.
      heartbeatAt: new Date(),
    })
    .returning({ id: attempts.id });
  const attemptId = insertedAttempt[0]?.id;
  if (!attemptId) throw new Error("Nepodařilo se založit attempt.");

  // Registr flotily: worker je od teď „busy" na tomto tasku (vidí /agents + dashboard).
  const agentId = await registerAgent({
    role: "worker",
    projectId: project.id,
    model,
    currentTaskId: task.id,
  });

  const key = await mintEphemeralKey({
    maxBudgetUsd: cfg.perAttemptBudgetUsd,
    duration: "35m",
    // scope:'attempt' + userId → LiteLLM zapíše worker spend do cost_ledger se
    // správným scope a atribucí uživateli (dřív scope chyběl).
    metadata: {
      userId: project.userId,
      taskId: task.id,
      projectId: project.id,
      attemptId,
      scope: "attempt",
    },
  });

  let containerId: string | null = null;
  let branch = "";
  let worktreePath = "";
  const startedAt = Date.now();

  // Heartbeat MUSÍ tikat od téhle chvíle, ne až od runWithLimits. Mezi vložením
  // řádku pokusu a spuštěním smyčky se stihne ensureRepo (git fetch), createWorktree,
  // start kontejneru a čekání, než naběhne opencode server — u větších rep minuty.
  // Reconciliace přitom pokus bez heartbeatu starší 3 minut uzná za mrtvý, zabije mu
  // kontejner a task znovu zařadí; čekající fetch pak spadne na "TypeError: fetch
  // failed". Tahle smyčka stála 202 z 204 selhání za týden a naparkovala 104 úkolů,
  // které zablokovaly všechno, co na nich viselo.
  // Poznávací znak v datech: heartbeat_at == started_at a steps_used = 0.
  const mainSetupHeartbeat = setInterval(() => {
    void touchHeartbeat(attemptId, 0).catch(() => undefined);
    void heartbeatAgent(agentId).catch(() => undefined);
  }, 30_000);

  try {
    // Repo + worktree
    await ensureRepo(project);
    const wt = await createWorktree(project.id, task.id);
    branch = wt.branch;
    worktreePath = wt.worktreePath;

    // Worker kontejner s mountnutým worktree jako /workspace
    const worker = await spawnWorker({ projectId: project.id, workspaceHostPath: worktreePath });
    containerId = worker.containerId;
    await heartbeatAgent(agentId, { containerId });

    await getDb()
      .update(attempts)
      .set({ branch, worktreeRef: worktreePath })
      .where(eq(attempts.id, attemptId));

    await logEvent({
      projectId: project.id,
      taskId: task.id,
      type: "attempt_started",
      message: `Worker start (${isFix ? "worker-fix" : "worker-build"}): ${task.title}`,
      data: { attemptId, branch },
    });

    // opencode session + prompt
    const session = await createSession(worker.baseUrl);
    await getDb()
      .update(attempts)
      .set({ opencodeSessionId: session.id })
      .where(eq(attempts.id, attemptId));

    const promptText = await buildPromptText(project.id, task, isFix, message.note);
    clearInterval(mainSetupHeartbeat); // dál heartbeatuje runWithLimits
    const outcome = await runWithLimits({
      baseUrl: worker.baseUrl,
      sessionId: session.id,
      apiKey: key.key,
      agent: isFix ? "worker-fix" : "worker-build",
      model,
      text: promptText,
      attemptId,
      agentId,
      startedAt,
    });

    if (outcome.kind === "aborted") {
      // Infra abort (limit kroků / wall-clock) → task zpět BEZ inkrementu attempts_count.
      await finalizeAttempt(attemptId, "aborted", outcome.steps, startedAt, outcome.text);
      await requeueNoPenalty(task, message, msgId, outcome.reason);
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "warn",
        type: "attempt_aborted",
        message: `Pokus přerušen (${outcome.reason}) — requeue bez penalizace.`,
      });
      return;
    }

    if (outcome.kind === "error") {
      // Chyba workera/infry → requeue bez penalizace (není to selhání tasku).
      await finalizeAttempt(attemptId, "failed", outcome.steps, startedAt, String(outcome.error));
      await requeueNoPenalty(task, message, msgId, "worker_error");
      await logEvent({
        projectId: project.id,
        taskId: task.id,
        level: "error",
        type: "attempt_error",
        message: `Worker chyba: ${String(outcome.error)}`,
      });
      return;
    }

    // Úspěšné dokončení sezení → commit worktree
    const commit = await commitWorktree(
      worktreePath,
      `farm: ${task.title}\n\nTask ${task.id}\n${task.doneCondition}`,
    );
    await updateProgress(project.id, task, commit.committed, outcome.text);

    // Pokus zůstává `running` až do verdiktu judge (attemptMachine: succeeded je
    // terminální). Jen zapíšeme metriky a čerstvý heartbeat; task jde do `judging`,
    // takže ho reconciliation nezabije jako mrtvý.
    await getDb()
      .update(attempts)
      .set({
        stepsUsed: outcome.steps,
        wallMs: Date.now() - startedAt,
        outputSummary: outcome.text.slice(0, 8000),
        diffStat: commit.diffStat ?? undefined,
        heartbeatAt: new Date(),
      })
      .where(eq(attempts.id, attemptId));

    // Předej judgeovi
    const judgeMsg: JudgeMessage = {
      attemptId,
      taskId: task.id,
      projectId: project.id,
      wishId: task.wishId,
      branch,
      worktreeRef: worktreePath,
    };
    // running → judging
    taskMachine.assert("running", "judging");
    await getDb().update(tasks).set({ status: "judging" }).where(eq(tasks.id, task.id));
    await enqueue(QUEUES.judge, judgeMsg);
    await ackDelete(QUEUES.tasks, msgId);

    await logEvent({
      projectId: project.id,
      taskId: task.id,
      type: "attempt_finished",
      message: `Pokus dokončen, předáno judgeovi. Kroků: ${outcome.steps}.`,
      data: { attemptId, committed: commit.committed },
    });
  } catch (err) {
    // Nečekaná chyba v dispatchi → attempt failed, requeue bez penalizace.
    await finalizeAttempt(attemptId, "failed", 0, startedAt, String(err)).catch(() => undefined);
    await requeueNoPenalty(task, message, msgId, "dispatch_exception").catch(() => undefined);
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "error",
      type: "dispatch_error",
      message: `Dispatch selhal: ${String(err)}`,
    });
  } finally {
    // Bezpodmínečně: když příprava spadne, do clearInterval výš se nedojde.
    clearInterval(mainSetupHeartbeat);
    // Worker skončil — uvolni ho z flotily (řádek smažeme, ať /agents ukazuje jen živé).
    await releaseAgent(agentId);
    await revokeKey(key.key).catch(() => undefined);
    if (containerId) await killContainer(containerId);
  }
}

type LimitOutcome =
  | { kind: "ok"; steps: number; text: string }
  | { kind: "aborted"; steps: number; text: string; reason: string }
  | { kind: "error"; steps: number; error: unknown };

/**
 * Spustí prompt a paralelně počítá kroky ze SSE; vynutí limity kroků a wall-clock.
 * Při překročení pošle abort a vrátí `aborted`.
 */
async function runWithLimits(args: {
  baseUrl: string;
  sessionId: string;
  apiKey: string;
  agent: string;
  model: string;
  text: string;
  attemptId: string;
  agentId: string | null;
  startedAt: number;
}): Promise<LimitOutcome> {
  const cfg = loadConfig();
  const controller = new AbortController();
  let steps = 0;
  let aborted = false;
  let abortReason = "";

  // Wall-clock strážce
  const timer = setTimeout(
    () => {
      aborted = true;
      abortReason = "wall_clock";
      void abortSession(args.baseUrl, args.sessionId);
      controller.abort();
    },
    cfg.attemptWallClockMin * 60_000,
  );

  // Periodický heartbeat — i když worker běží tiše (dlouhý build/test bez SSE
  // step eventů), attempt nesmí vypadat mrtvě a být reapnut reconciliací a nahrazen
  // druhým workerem na tomtéž worktree.
  const heartbeat = setInterval(() => {
    void touchHeartbeat(args.attemptId, steps).catch(() => undefined);
    void heartbeatAgent(args.agentId).catch(() => undefined);
  }, 30_000);

  // Sledovač SSE — počítá kroky a udržuje heartbeat.
  const watcher = (async () => {
    try {
      for await (const ev of subscribeEvents(args.baseUrl, controller.signal)) {
        if (isStepEvent(ev)) {
          steps++;
          await touchHeartbeat(args.attemptId, steps).catch(() => undefined);
          await heartbeatAgent(args.agentId).catch(() => undefined);
          if (steps > cfg.maxStepsPerAttempt) {
            aborted = true;
            abortReason = "max_steps";
            void abortSession(args.baseUrl, args.sessionId);
            controller.abort();
            break;
          }
        }
        if (isWallClockExceeded(new Date(args.startedAt), new Date(), cfg.attemptWallClockMin)) {
          aborted = true;
          abortReason = "wall_clock";
          void abortSession(args.baseUrl, args.sessionId);
          controller.abort();
          break;
        }
      }
    } catch {
      /* stream ukončen / abortnut */
    }
  })();

  try {
    const result = await prompt(args.baseUrl, args.sessionId, {
      agent: args.agent,
      model: args.model,
      text: args.text,
      apiKey: args.apiKey,
      signal: controller.signal,
    });
    clearTimeout(timer);
    clearInterval(heartbeat);
    controller.abort();
    await watcher.catch(() => undefined);
    if (aborted) return { kind: "aborted", steps, text: result.text, reason: abortReason };
    return { kind: "ok", steps, text: result.text };
  } catch (err) {
    clearTimeout(timer);
    clearInterval(heartbeat);
    controller.abort();
    await watcher.catch(() => undefined);
    if (aborted) return { kind: "aborted", steps, text: "", reason: abortReason };
    return { kind: "error", steps, error: err };
  }
}

/**
 * Heuristika počítání kroků z opencode eventů. Různé verze opencode pojmenovávají
 * eventy jinak — počítáme nové obsahové části / tool volání jako „kroky".
 * Při upgradu opencode případně dolaď.
 */
function isStepEvent(ev: OpencodeEvent): boolean {
  // opencode 1.18 streamuje desítky part.delta/part.updated eventů na JEDEN
  // model-turn → počítat je jako kroky přeteče strop po ~2 taženích. Reálná
  // hranice agent-kroku je "step-finish", ALE na /event streamu je zanořená:
  // { type:"message.part.updated", properties:{ part:{ type:"step-finish" }}}.
  const part = (ev.properties as { part?: { type?: string } } | undefined)?.part;
  return part?.type === "step-finish";
}

async function touchHeartbeat(attemptId: string, steps: number): Promise<void> {
  await getDb()
    .update(attempts)
    .set({ heartbeatAt: new Date(), stepsUsed: steps })
    .where(eq(attempts.id, attemptId));
}

async function finalizeAttempt(
  attemptId: string,
  status: "succeeded" | "failed" | "aborted",
  steps: number,
  startedAt: number,
  outputSummary: string,
): Promise<void> {
  await getDb()
    .update(attempts)
    .set({
      status,
      stepsUsed: steps,
      wallMs: Date.now() - startedAt,
      finishedAt: new Date(),
      outputSummary: outputSummary.slice(0, 8000),
    })
    .where(eq(attempts.id, attemptId));
}

/** Task zpět do fronty BEZ inkrementu attempts_count (infra abort / rate limit). */
async function requeueNoPenalty(
  task: TaskRow,
  message: TaskMessage,
  msgId: string,
  reason: string,
): Promise<void> {
  // BOUND: infra requeue je bez penalizace (nezvyšuje attempts_count), takže
  // deterministicky selhávající infra (worker se pořád hroutí) by točila donekonečna.
  // Po MAX_INFRA_RETRIES task zaparkuj + alert místo nekonečného re-dispatche.
  const MAX_INFRA_RETRIES = Number(process.env.MAX_INFRA_RETRIES ?? 10);
  // Čítač se čte a zvyšuje ATOMICKY v DB — ne z payloadu zprávy. V payloadu ho
  // resetovalo na 0 každé z 8 míst, která TaskMessage staví znovu, takže se
  // bound nikdy nenaplnil. Atomický UPDATE navíc řeší závod 4 dispatch smyček,
  // které by jinak přečetly stejnou hodnotu a zvýšily ji na totéž číslo.
  const bumped = await getSql()<{ infra_retries: number }[]>`
    UPDATE tasks SET infra_retries = infra_retries + 1
    WHERE id = ${task.id} RETURNING infra_retries
  `;
  const infraRetries = bumped[0]?.infra_retries ?? 1;
  if (infraRetries > MAX_INFRA_RETRIES) {
    await getDb().update(tasks).set({ status: "parked" }).where(eq(tasks.id, task.id));
    await ackDelete(QUEUES.tasks, msgId);
    await logEvent({
      projectId: task.projectId,
      taskId: task.id,
      level: "error",
      type: "task_parked_infra",
      message: `Task zaparkován po ${MAX_INFRA_RETRIES} infra selháních (${reason}) — vyžaduje zásah.`,
    });
    return;
  }
  // running → queued (infra kill; bez penalizace, viz taskMachine)
  await getDb().update(tasks).set({ status: "queued" }).where(eq(tasks.id, task.id));
  const requeued: TaskMessage = { ...message, note: reason };
  // Exponenciální backoff (2^n s, strop 5 min). Bez něj se zpráva vracela okamžitě
  // viditelná a 4 dispatch smyčky po 2 s ji semlely tisíckrát za hodinu.
  const delaySec = Math.min(300, 2 ** infraRetries);
  await enqueue(QUEUES.tasks, requeued, delaySec);
  await ackDelete(QUEUES.tasks, msgId);
}

/**
 * Sestaví prompt pro workera z tasku (+ feedback při opravě).
 * PREPEND: nastřádaný PROJECT BRIEF (architektura + konvence + poučení) a
 * lokální .farm handoff, aby worker stavěl s akumulovanými znalostmi, ne naslepo.
 * DESCRIPTION už obsahuje VERIFY METHOD (vložený architektem při plánování).
 */
async function buildPromptText(
  projectId: string,
  task: TaskRow,
  isFix: boolean,
  note?: string,
): Promise<string> {
  const parts: string[] = [];

  // KONSTITUCE jako stabilní prefix KAŽDÉHO worker promptu (jak slibují worker-*.md).
  // Musí být první — sdílená doktrína (laťka kvality, čestnost, least-privilege) +
  // cache-friendly prefix. Bez ní worker (ten, co píše shipovaný kód) neběžel pod
  // stejnými pravidly jako zbytek farmy.
  parts.push(CONSTITUTION);

  // Znalostní báze projektu jako ground truth (nesmí se re-litigovat).
  const brief = await assembleBrief(projectId).catch(() => "");
  if (brief) parts.push(brief);

  // Lokální handoff (co už agenti v projektu udělali) — necommitovaný .farm/progress.md.
  const handoff = await readHandoff(projectId);
  if (handoff) parts.push(`# HANDOFF (recent progress in this project)\n${handoff}`);

  parts.push(
    `TASK: ${task.title}`,
    `DESCRIPTION:\n${task.description}`,
    `DONE CONDITION (must be satisfied):\n${task.doneCondition}`,
  );
  if (note) parts.push(`STEERING NOTE:\n${note}`);

  if (isFix) {
    // Přilož důvod posledního rejectu, ať worker ví, co opravit.
    const lastReview = await getDb()
      .select({ reasons: reviews.reasons })
      .from(reviews)
      .innerJoin(attempts, eq(reviews.attemptId, attempts.id))
      .where(eq(attempts.taskId, task.id))
      .orderBy(desc(reviews.createdAt))
      .limit(1);
    const reasons = lastReview[0]?.reasons;
    if (reasons) parts.push(`PREVIOUS REVIEW FEEDBACK (fix these):\n${reasons}`);
    parts.push(
      "This is a FIX attempt. Address the feedback above without weakening or deleting tests, and without touching build/CI/harness config.",
    );
  } else {
    parts.push(
      "Implement the task fully. Do not modify build scripts, lockfiles, tsconfig, lint/test config or CI. Keep changes focused.",
    );
  }
  return parts.join("\n\n");
}

/** Přečte konec .farm/progress.md (handoff) hlavního workspace; "" když chybí. */
async function readHandoff(projectId: string): Promise<string> {
  try {
    const progressPath = join(loadConfig().workspacesRoot, projectId, ".farm", "progress.md");
    const raw = await fs.readFile(progressPath, "utf8");
    // Jen posledních ~1500 znaků (nejnovější postup), ať prompt nenabobtná.
    return raw.length > 1500 ? `…\n${raw.slice(-1500)}` : raw;
  } catch {
    return "";
  }
}

/** Zapíše lokální handoff stav do .farm/progress.md v hlavním workspace (necommitujeme). */
async function updateProgress(
  projectId: string,
  task: TaskRow,
  committed: boolean,
  summary: string,
): Promise<void> {
  try {
    const progressPath = join(loadConfig().workspacesRoot, projectId, ".farm", "progress.md");
    await fs.mkdir(dirname(progressPath), { recursive: true });
    const line = `- [${new Date().toISOString()}] ${task.title} — committed=${committed}\n  ${summary.slice(0, 300).replace(/\n/g, " ")}\n`;
    await fs.appendFile(progressPath, line, "utf8");
  } catch (err) {
    console.error("[dispatch] update progress.md selhalo:", err);
  }
}
