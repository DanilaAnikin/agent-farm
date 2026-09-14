/**
 * Refill loop (per projekt) — jádro nekonečnosti (OVERVIEW §5.2).
 * Projekt `active`, žádné queued/running tasky a žádná otevřená přání →
 * manager vygeneruje další dávku vylepšení.
 *
 * MECHANICKÉ GUARDY (mimo prompt):
 *  (a) dedup nových tasků proti dedup_key VŠECH tasků projektu (trigram ≥ threshold)
 *      + seznam hotových jde do promptu (trigram neuvidí překlad téhož zadání);
 *  (b) max refill_max_rounds_per_day kol na projekt/den (počítáno z events);
 *  (c) parked task znovu otevře jen člověk (nikdy je neresuscitujeme).
 */
import { getSql, getDb, projects, tasks, wishes, QUEUES, enqueue } from "@farm/db";
import { and, eq, inArray } from "drizzle-orm";
import { loadConfig, taskDedupKey, isDuplicate } from "@farm/core";
import { MODELS, structured, refillPrompt, validateRefill } from "@farm/llm";
import type { RefillOutput } from "@farm/llm";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";
import { assembleBrief } from "./memory.js";
import type { TaskMessage } from "./types.js";
import { gatherRepoState } from "./repo-state.js";
import { ensureRepo } from "./git.js";

const REFILL_ROUND_EVENT = "refill_round";

/** Jedna iterace refill loopu — projde aktivní projekty s prázdným backlogem. */
export async function runRefillOnce(): Promise<void> {
  if (await isGlobalPaused()) return;
  const cfg = loadConfig();

  const activeProjects = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.status, "active"));

  for (const project of activeProjects) {
    try {
      if (await hasOpenWork(project.id)) continue;
      if ((await refillRoundsToday(project.id)) >= cfg.refillMaxRoundsPerDay) continue;
      await ensureRepo(project);
      await refillProject(project.id, project.userId, project.kind, project.managerNote);
    } catch (err) {
      console.error(`[refill] projekt ${project.id} selhal:`, err);
    }
  }
}

/** Má projekt otevřenou práci (queued/running/judging tasky nebo neuzavřená přání)? */
async function hasOpenWork(projectId: string): Promise<boolean> {
  const openTasks = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, ["queued", "running", "judging"])))
    .limit(1);
  if (openTasks.length > 0) return true;

  const openWishes = await getDb()
    .select({ id: wishes.id })
    .from(wishes)
    .where(
      and(
        eq(wishes.projectId, projectId),
        inArray(wishes.status, ["new", "specifying", "awaiting_spec_approval", "active"]),
      ),
    )
    .limit(1);
  return openWishes.length > 0;
}

/** Kolik refill kol proběhlo dnes (počítáno z events). */
async function refillRoundsToday(projectId: string): Promise<number> {
  const rows = await getSql()<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM events
    WHERE project_id = ${projectId}
      AND type = ${REFILL_ROUND_EVENT}
      AND ts >= date_trunc('day', now())
  `;
  return rows[0]?.count ?? 0;
}

async function refillProject(
  projectId: string,
  userId: string,
  projectKind: string,
  managerNote: string | null,
): Promise<void> {
  const cfg = loadConfig();

  // Dedup se dřív porovnával JEN proti parked/failed. Hotový úkol tím pádem nic
  // nebránilo navrhnout znovu — ripieno tak vyrobilo čtyři varianty „Result type +
  // AppError hierarchy" a čtyři varianty „nastav Jest", každou jako samostatný PR
  // se svou paralelní strukturou. Guard proto bere VŠECHNY tasky projektu.
  const guardedTasks = await getDb()
    .select({ title: tasks.title, dedupKey: tasks.dedupKey, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  const existingKeys = guardedTasks.map((t) => t.dedupKey).filter((k) => k.length > 0);
  const parkedTitles = guardedTasks.filter((t) => t.status === "parked").map((t) => t.title);
  // Trigramová podobnost neuvidí, že „Nastavit Jest s ts-jest" a „Set up Jest with
  // ts-jest" je totéž — jsou to jiné znaky. Sémantickou vrstvu musí udělat model,
  // takže mu dáme seznam už hotového.
  const doneTitles = guardedTasks
    .filter((t) => t.status === "done")
    .map((t) => t.title)
    .slice(-60);

  const repoState = await gatherRepoState(projectId);
  // Nastřádané znalosti projektu (architektura + konvence + poučení) → refill je čte,
  // aby další dávka vylepšení stavěla na tom, co už je rozhodnuté a naučené.
  const brief = await assembleBrief(projectId);

  const refill = await structured<RefillOutput>({
    model: MODELS.manager,
    messages: refillPrompt({
      projectKind,
      repoState,
      managerNote,
      parkedTasks: parkedTitles,
      doneTasks: doneTitles,
      maxTasks: cfg.refillMaxTasksPerRound,
      projectBrief: brief || undefined,
    }),
    validate: validateRefill,
    metadata: { userId, projectId, scope: "system" },
  });

  // Zaznamenej kolo (i prázdné) — kvůli dennímu limitu.
  await logEvent({
    projectId,
    type: REFILL_ROUND_EVENT,
    message: `Refill kolo: ${refill.data.tasks.length} kandidátů. ${refill.data.reasoning}`,
    data: { candidates: refill.data.tasks.length },
  });

  let created = 0;
  let deduped = 0;
  for (const t of refill.data.tasks) {
    const key = taskDedupKey(t.title, t.done_condition);
    if (isDuplicate(key, existingKeys, cfg.dedupSimilarityThreshold)) {
      deduped++;
      await logEvent({
        projectId,
        type: "refill_dedup",
        message: `Task přeskočen (duplikát existujícího): ${t.title}`,
      });
      continue;
    }
    existingKeys.push(key); // dedup i v rámci jednoho kola

    const inserted = await getDb()
      .insert(tasks)
      .values({
        projectId,
        kind: t.kind,
        title: t.title,
        description: t.description,
        doneCondition: t.done_condition,
        status: "queued",
        priority: t.priority ?? 100,
        maxAttempts: cfg.maxTaskAttempts,
        dedupKey: key,
      })
      .returning({ id: tasks.id });
    const taskId = inserted[0]?.id;
    if (!taskId) continue;

    const msg: TaskMessage = { taskId, projectId, kind: t.kind };
    await enqueue(QUEUES.tasks, msg);
    created++;
  }

  await logEvent({
    projectId,
    type: "refill_done",
    message: `Refill: vytvořeno ${created}, deduplikováno ${deduped}.`,
    data: { created, deduped },
  });
}
