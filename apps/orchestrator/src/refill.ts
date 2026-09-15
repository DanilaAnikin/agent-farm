/**
 * Refill loop (per projekt) — jádro nekonečnosti (OVERVIEW §5.2).
 * Projekt `active`, žádné queued/running/judging/merging tasky a žádná otevřená
 * přání → manager vygeneruje další dávku vylepšení.
 *
 * MECHANICKÉ GUARDY (mimo prompt):
 *  (a) dedup nových tasků proti dedup_key VŠECH tasků projektu (trigram ≥ threshold)
 *      + seznam hotových jde do promptu (trigram neuvidí překlad téhož zadání);
 *  (b) max refill_max_rounds_per_day kol na projekt/den (počítáno z events);
 *  (c) parked task znovu otevře jen člověk (nikdy je neresuscitujeme);
 *  (d) práce nad NEZMERGOVANÝM kódem: úkol ve stavu `merging` je rozpracovaná
 *      práce (refill se nespustí) a otevřené PR farmy jdou do promptu, ať plánovač
 *      nestaví nad kódem, který v main ještě není.
 */
import { getSql, getDb, projects, tasks, wishes, QUEUES, enqueue } from "@farm/db";
import type { TaskStatus } from "@farm/db";
import { and, eq, inArray } from "drizzle-orm";
import { Octokit } from "@octokit/rest";
import { loadConfig, taskDedupKey, isDuplicate } from "@farm/core";
import { MODELS, structured, refillPrompt, validateRefill } from "@farm/llm";
import type { RefillOutput } from "@farm/llm";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";
import { assembleBrief, ensureProjectIdentity } from "./memory.js";
import type { TaskMessage } from "./types.js";
import { gatherRepoState } from "./repo-state.js";
import { ensureRepo, githubCredsForUser, parseGithubUrl } from "./git.js";

const REFILL_ROUND_EVENT = "refill_round";
/** Kolik otevřených PR farmy (a jejich souborů) se vejde do promptu. */
const MAX_OPEN_PRS = 10;
const MAX_PR_FILES = 30;

/**
 * Stavy úkolu, které znamenají rozdělanou práci. `merging` sem patří: PR je
 * otevřený, ale kód v main ještě není — nová dávka by na něm stavěla naslepo.
 */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "judging", "merging"];
const OPEN_WISH_STATUSES = ["new", "specifying", "awaiting_spec_approval", "active"] as const;

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
      // Pojistka, dokud merge smyčka neběží: úkol ve stavu merging = rozdělaná práce,
      // takže projekt s nesloučeným PR refill nespustí vůbec (viz OPEN_TASK_STATUSES).
      if (await hasOpenWork(project.id)) continue;
      if ((await refillRoundsToday(project.id)) >= cfg.refillMaxRoundsPerDay) continue;
      await ensureRepo(project);
      const identity = await ensureProjectIdentity(project);
      const openPullRequests = await listOpenFarmPullRequests(project);
      await refillProject(project.id, project.userId, project.kind, project.managerNote, identity, openPullRequests);
    } catch (err) {
      console.error(`[refill] projekt ${project.id} selhal:`, err);
    }
  }
}

/**
 * Má projekt otevřenou práci (queued/running/judging/merging tasky nebo neuzavřená
 * přání)? Sdílí ho refill i příjem návrhů (suggestions.ts).
 */
export async function hasOpenWork(projectId: string): Promise<boolean> {
  const openTasks = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
    .limit(1);
  if (openTasks.length > 0) return true;

  const openWishes = await getDb()
    .select({ id: wishes.id })
    .from(wishes)
    .where(and(eq(wishes.projectId, projectId), inArray(wishes.status, [...OPEN_WISH_STATUSES])))
    .limit(1);
  return openWishes.length > 0;
}

/**
 * Otevřené PR farmy (větve `farm/…`) s titulkem a změněnými soubory. Jen pro
 * existující repa — nová repa farmy se slévají rovnou do main. Chyba GitHubu
 * refill nezastaví: vrátí prázdný seznam.
 */
export async function listOpenFarmPullRequests(project: {
  id: string;
  userId: string;
  repoMode: string;
  repoUrl: string | null;
}): Promise<{ title: string; files: string[] }[]> {
  if (project.repoMode !== "existing" || !project.repoUrl) return [];
  try {
    const creds = await githubCredsForUser(project.userId);
    if (!creds.token) return [];
    const { owner, repo } = parseGithubUrl(project.repoUrl);
    const octokit = new Octokit({ auth: creds.token });
    const pulls = await octokit.pulls.list({ owner, repo, state: "open", per_page: 50 });
    const farm = pulls.data.filter((pr) => pr.head.ref.startsWith("farm/")).slice(0, MAX_OPEN_PRS);
    const out: { title: string; files: string[] }[] = [];
    for (const pr of farm) {
      const files = await octokit.pulls
        .listFiles({ owner, repo, pull_number: pr.number, per_page: MAX_PR_FILES })
        .then((r) => r.data.map((f) => f.filename))
        .catch(() => [] as string[]);
      out.push({ title: pr.title, files });
    }
    return out;
  } catch (err) {
    // Jen HTTP status — text chyby do logu nepouštíme (ochrana před únikem URL s tokenem).
    const status = (err as { status?: number }).status;
    console.warn(`[refill] otevřené PR projektu ${project.id} nešly načíst (${status ?? "chyba"}).`);
    return [];
  }
}

// Krátký seznam anglických sloves, kterými plánovač začínal názvy úkolů.
const ENGLISH_TITLE_VERBS = new Set([
  "add", "fix", "implement", "create", "update", "refactor", "remove", "set", "setup", "configure",
  "write", "build", "integrate", "improve", "migrate", "enable", "support", "introduce", "extract",
  "replace", "ensure", "handle", "make", "move", "rename", "delete", "document", "test", "allow",
  "use", "wire", "expose", "validate", "optimize", "upgrade", "bump", "clean", "convert", "generate",
  "prevent", "show", "display", "render", "store", "persist", "track", "log", "deploy", "harden",
]);

/**
 * Levná kontrola jazyka názvu úkolu (bez LLM): žádná česká diakritika A první
 * slovo je anglické sloveso. Názvy jsou pro uživatele, mají být česky.
 */
export function isLikelyEnglishTitle(title: string): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (/[áčďéěíňóřšťúůýž]/i.test(t)) return false;
  const first = t.split(/[\s:/(\[-]+/).find(Boolean)?.toLowerCase() ?? "";
  return ENGLISH_TITLE_VERBS.has(first);
}

/** Zaloguje `task_title_language`, když název vypadá anglicky. Název NEPŘEPISUJE. */
export async function checkTaskTitleLanguage(input: {
  projectId: string;
  wishId?: string | null;
  taskId: string;
  title: string;
}): Promise<void> {
  if (!isLikelyEnglishTitle(input.title)) return;
  await logEvent({
    projectId: input.projectId,
    wishId: input.wishId ?? null,
    taskId: input.taskId,
    level: "info",
    type: "task_title_language",
    message: `Název úkolu není česky: ${input.title}`,
    data: { title: input.title },
  });
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
  projectIdentity: string | null,
  openPullRequests: { title: string; files: string[] }[],
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
      managerNote: managerNote?.trim() || null,
      parkedTasks: parkedTitles,
      doneTasks: doneTitles,
      maxTasks: cfg.refillMaxTasksPerRound,
      projectBrief: brief || undefined,
      projectIdentity,
      openPullRequests,
    }),
    validate: validateRefill,
    metadata: { userId, projectId, scope: "system" },
  });

  // Zaznamenej kolo (i prázdné) — kvůli dennímu limitu.
  await logEvent({
    projectId,
    type: REFILL_ROUND_EVENT,
    message: `Refill kolo: ${refill.data.tasks.length} kandidátů. ${refill.data.reasoning}`,
    data: { candidates: refill.data.tasks.length, openPullRequests: openPullRequests.length },
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
    await checkTaskTitleLanguage({ projectId, taskId, title: t.title });
    created++;
  }

  await logEvent({
    projectId,
    type: "refill_done",
    message: `Refill: vytvořeno ${created}, deduplikováno ${deduped}.`,
    data: { created, deduped },
  });
}
