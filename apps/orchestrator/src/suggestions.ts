/**
 * Proaktivní návrhy (UNIVERZÁLNÍ, kind-agnostické) + self-run exekuce.
 *  - generateSuggestionsForProject: strategist navrhne "co dál" pro JAKÝKOLIV cíl
 *    projektu (feature/fix/test/automatizace/integrace/výzkum/refaktor/content/…),
 *    gate na kadenci, dedup, insert suggestions + event 'suggestion_new'.
 *  - convertSuggestionToWish: z návrhu udělá přání (manager si ho vyzvedne).
 *  - runSelfRunOnce: u projektů s autonomy.selfRun sám převádí návrhy na přání.
 */
import {
  getDb,
  getSql,
  projects,
  suggestions,
  wishes,
  events,
  QUEUES,
  enqueue,
} from "@farm/db";
import type { ProjectAutonomy, SuggestionKind } from "@farm/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { similarity } from "@farm/core";
import { MODELS, structured, strategistPrompt, validateStrategy } from "@farm/llm";
import type { StrategyOutput } from "@farm/llm";
import { creditBalance } from "@farm/billing";
import { assembleBrief } from "./memory.js";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";

const DEFAULT_CADENCE_H = 12;
const DEFAULT_MAX_SUGGESTIONS = 5;
const DEDUP_THRESHOLD = 0.8;
// Když má projekt hodně nevyřízené práce, nový návrh nemá smysl.
const DROWNING_OPEN_TASKS = 6;

type Project = typeof projects.$inferSelect;

function autonomy(p: Project): ProjectAutonomy {
  return (p.autonomy ?? {}) as ProjectAutonomy;
}

/** Uplynula od posledního generování návrhů kadence? */
async function cadenceElapsed(projectId: string, cadenceH: number): Promise<boolean> {
  const rows = await getSql()<{ ts: string }[]>`
    SELECT ts FROM events
    WHERE project_id = ${projectId} AND type = 'suggestions_generated'
    ORDER BY ts DESC LIMIT 1
  `;
  const last = rows[0]?.ts;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= cadenceH * 3_600_000;
}

async function openTaskCount(projectId: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tasks
    WHERE project_id = ${projectId} AND status IN ('queued','running','judging')
  `;
  return rows[0]?.n ?? 0;
}

/** Krátký souhrn cíle projektu z posledních přání. */
async function goalSummary(projectId: string, projectName: string): Promise<string> {
  const rows = await getDb()
    .select({ title: wishes.title, description: wishes.description })
    .from(wishes)
    .where(eq(wishes.projectId, projectId))
    .orderBy(desc(wishes.createdAt))
    .limit(4);
  if (rows.length === 0) return projectName;
  return rows.map((r) => `- ${r.title}`).join("\n");
}

/** Posledních pár událostí jako text (kontext pro strategistu). */
async function recentActivity(projectId: string): Promise<string> {
  const rows = await getDb()
    .select({ type: events.type, message: events.message })
    .from(events)
    .where(eq(events.projectId, projectId))
    .orderBy(desc(events.ts))
    .limit(8);
  return rows.map((r) => `- ${r.type}: ${r.message}`).join("\n");
}

/** Tituly, proti kterým dedupujeme (otevřené návrhy + zaparkované/selhané tasky). */
async function existingTitles(projectId: string): Promise<string[]> {
  const sug = await getDb()
    .select({ title: suggestions.title })
    .from(suggestions)
    .where(
      and(eq(suggestions.projectId, projectId), inArray(suggestions.status, ["new", "accepted"])),
    );
  const parked = await getSql()<{ title: string }[]>`
    SELECT title FROM tasks
    WHERE project_id = ${projectId} AND status IN ('parked','failed')
    ORDER BY created_at DESC LIMIT 30
  `;
  return [...sug.map((s) => s.title), ...parked.map((p) => p.title)];
}

/** Vygeneruje návrhy pro jeden projekt (pokud je čas a dává to smysl). */
export async function generateSuggestionsForProject(project: Project): Promise<void> {
  const a = autonomy(project);
  if (a.proactive === false) return; // opt-out (default zapnuto)
  if (project.status !== "active") return;

  const cadenceH = a.cadenceHours && a.cadenceHours > 0 ? a.cadenceHours : DEFAULT_CADENCE_H;
  if (!(await cadenceElapsed(project.id, cadenceH))) return;
  if ((await openTaskCount(project.id)) >= DROWNING_OPEN_TASKS) return;

  // Kredity — návrhy stojí LLM volání; bez kreditu je negenerujeme.
  const credit = await creditBalance(project.userId).catch(() => null);
  if (credit && !credit.ok) return;

  const max = a.maxSuggestionsPerRound && a.maxSuggestionsPerRound > 0 ? a.maxSuggestionsPerRound : DEFAULT_MAX_SUGGESTIONS;

  let out: StrategyOutput;
  try {
    const res = await structured<StrategyOutput>({
      model: MODELS.manager,
      messages: strategistPrompt({
        projectName: project.name,
        projectKind: project.kind,
        goalSummary: await goalSummary(project.id, project.name),
        projectBrief: await assembleBrief(project.id).catch(() => ""),
        recentActivity: await recentActivity(project.id),
        managerNote: project.managerNote ?? undefined,
        maxSuggestions: max,
      }),
      validate: validateStrategy,
      metadata: { userId: project.userId, projectId: project.id, scope: "system" },
    });
    out = res.data;
  } catch (err) {
    console.error(`[suggestions] strategist projektu ${project.id} selhal:`, err);
    return;
  }

  const existing = await existingTitles(project.id);
  let inserted = 0;
  for (const s of out.suggestions.slice(0, max)) {
    const title = s.title.trim();
    if (!title) continue;
    if (existing.some((e) => similarity(title, e) >= DEDUP_THRESHOLD)) continue;
    existing.push(title);

    const row = await getDb()
      .insert(suggestions)
      .values({
        userId: project.userId,
        projectId: project.id,
        kind: normalizeKind(s.kind),
        title,
        description: s.description.trim(),
        rationale: s.rationale?.trim() ?? null,
        source: "strategist",
        status: "new",
      })
      .returning({ id: suggestions.id });
    const id = row[0]?.id;
    inserted++;
    // Event MUSÍ mít projectId, aby ho Telegram reporter doručil uživateli.
    await logEvent({
      projectId: project.id,
      type: "suggestion_new",
      message: `Farma navrhuje: ${title}`,
      data: { title, kind: normalizeKind(s.kind), suggestionId: id },
    });
  }

  await logEvent({
    projectId: project.id,
    type: "suggestions_generated",
    message: `Vygenerováno ${inserted} nových návrhů.`,
    data: { count: inserted },
  });
}

function normalizeKind(kind: string): SuggestionKind {
  // Strategist validátor už zaručil, že kind je z povolené množiny (lowercase).
  return kind.trim().toLowerCase() as SuggestionKind;
}

/** Z návrhu vytvoří přání (a označí návrh jako converted). Vrací id přání. */
export async function convertSuggestionToWish(
  suggestionId: string,
  source: "dashboard" | "telegram" = "telegram",
): Promise<string | null> {
  const rows = await getDb().select().from(suggestions).where(eq(suggestions.id, suggestionId)).limit(1);
  const s = rows[0];
  if (!s || !s.projectId || s.status === "converted") return null;

  const description = [s.description, s.rationale ? `\n\n(Proč: ${s.rationale})` : ""]
    .filter(Boolean)
    .join("");
  const wishRow = await getDb()
    .insert(wishes)
    .values({
      projectId: s.projectId,
      title: s.title,
      description,
      source,
      status: "new",
    })
    .returning({ id: wishes.id });
  const wishId = wishRow[0]?.id ?? null;

  await getDb()
    .update(suggestions)
    .set({ status: "converted", wishId, decidedAt: new Date() })
    .where(eq(suggestions.id, suggestionId));

  await logEvent({
    projectId: s.projectId,
    wishId,
    type: "wish_created",
    message: `Návrh přijat → přání: ${s.title}`,
    data: { source: "suggestion", suggestionId },
  });
  return wishId;
}

/** Smyčka: pro všechny vhodné projekty vygeneruj návrhy. */
export async function runSuggestionsOnce(): Promise<void> {
  if (await isGlobalPaused()) return;
  const active = await getDb().select().from(projects).where(eq(projects.status, "active"));
  for (const p of active) {
    await generateSuggestionsForProject(p).catch((e) =>
      console.error(`[suggestions] projekt ${p.id} selhal:`, e),
    );
  }
}

/** Self-run: u projektů s autonomy.selfRun sám převeď top návrhy na přání. */
export async function runSelfRunOnce(): Promise<void> {
  if (await isGlobalPaused()) return;
  const active = await getDb().select().from(projects).where(eq(projects.status, "active"));
  for (const p of active) {
    const a = autonomy(p);
    if (!a.selfRun) continue;
    // Nezahlcuj: jen když projekt nemá moc rozdělané práce.
    if ((await openTaskCount(p.id)) >= DROWNING_OPEN_TASKS) continue;
    const credit = await creditBalance(p.userId).catch(() => null);
    if (credit && !credit.ok) continue;

    const news = await getDb()
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(and(eq(suggestions.projectId, p.id), eq(suggestions.status, "new")))
      .orderBy(desc(suggestions.createdAt))
      .limit(1); // po jednom za kolo — ať se to nezasekne v jedné dávce
    const top = news[0];
    if (!top) continue;

    const wishId = await convertSuggestionToWish(top.id, "dashboard").catch(() => null);
    if (wishId) {
      await logEvent({
        projectId: p.id,
        wishId,
        type: "self_run",
        message: "Autopilot: návrh sám převeden na přání a spuštěn.",
      });
    }
  }
}
