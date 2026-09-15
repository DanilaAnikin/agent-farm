/**
 * Proaktivní návrhy (UNIVERZÁLNÍ, kind-agnostické) + jejich AUTOMATICKÝ PŘÍJEM.
 *  - generateSuggestionsForProject: strategist navrhne "co dál" pro JAKÝKOLIV cíl
 *    projektu. Vidí ověřenou identitu projektu a fakta z repa; každý návrh musí
 *    citovat soubor nebo fakt z repa, jinak se zahodí. Duplicity řeší isKnownWork.
 *  - runSelfRunOnce: příjem návrhů — farma o KAŽDÉM novém návrhu rozhodne sama
 *    (zadá ho jako přání, nebo ho s důvodem zahodí). Nikdo nemusí klikat.
 *  - convertSuggestionToWish: tenký obal nad jedinou implementací v @farm/db.
 */
import { getDb, getSql, projects, suggestions, wishes, events, convertSuggestionToWish as convertInDb } from "@farm/db";
import type { ConvertSuggestionSource, ProjectAutonomy, ProjectStatus, SuggestionKind } from "@farm/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { normalize } from "@farm/core";
import { MODELS, structured, strategistPrompt, validateStrategy, withEvidence } from "@farm/llm";
import type { StrategyOutput } from "@farm/llm";
import { creditBalance } from "@farm/billing";
import { assembleBrief, ensureProjectIdentity } from "./memory.js";
import { logEvent } from "./events.js";
import { getSetting, isGlobalPaused, shouldFarmRun } from "./settings.js";
import { isKnownWork, knownWorkKindLabel } from "./work-dedup.js";
import type { KnownWorkResult } from "./work-dedup.js";
import { hasOpenWork } from "./refill.js";
import { gatherRepoState } from "./repo-state.js";

const DEFAULT_CADENCE_H = 12;
const DEFAULT_MAX_SUGGESTIONS = 5;
// Když má projekt hodně nevyřízené práce, nový návrh nemá smysl.
const DROWNING_OPEN_TASKS = 6;
/** Výchozí strop přání, která farma sama zadá do jednoho projektu za den (farm_settings.max_auto_wishes_per_day). */
export const DEFAULT_MAX_AUTO_WISHES_PER_DAY = 2;
/** Kolik nových návrhů intake posoudí v jednom kole (smyčka běží á 60 s). */
const INTAKE_BATCH = 25;
/** Strop placených sémantických kontrol duplicit v jednom kole intake. */
const SEMANTIC_CALLS_PER_ROUND = 3;
/** Nečinný projekt si nové návrhy vynutí nejvýš jednou za tolik hodin. */
const IDLE_REFILL_MIN_H = 6;
/** Kolik znaků faktů z repa dostane strategist. */
const STRATEGIST_REPO_FACTS_CHARS = 4000;

type Project = typeof projects.$inferSelect;

function autonomy(p: Project): ProjectAutonomy {
  return (p.autonomy ?? {}) as ProjectAutonomy;
}

/** České množné číslo pro celá čísla (1 návrh, 2 návrhy, 5 návrhů). */
export function czCount(n: number, forms: readonly [string, string, string]): string {
  const cat = new Intl.PluralRules("cs").select(n);
  const form = cat === "one" ? forms[0] : cat === "few" ? forms[1] : forms[2];
  return `${n} ${form}`;
}

/** Zdůvodnění návrhu doplněné o doklad z repozitáře (evidence). */
export function joinRationale(rationale: string | null | undefined, evidence: string | null | undefined): string | null {
  const parts = [rationale?.trim(), evidence?.trim() ? `Doklad z repozitáře: ${evidence.trim()}` : ""].filter(
    (x): x is string => Boolean(x),
  );
  return parts.length ? parts.join("\n") : null;
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
    WHERE project_id = ${projectId} AND status IN ('queued','running','judging','merging')
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

/** Titulky známé práce do promptu (sémantický guard — dedup je stejně po generování). */
async function knownWorkTitles(projectId: string): Promise<string[]> {
  const rows = await getSql()<{ title: string }[]>`
    SELECT title FROM (
      SELECT title, created_at FROM wishes WHERE project_id = ${projectId}
      UNION ALL
      SELECT title, created_at FROM suggestions
      WHERE project_id = ${projectId} AND created_at >= now() - interval '30 days'
    ) x
    ORDER BY created_at DESC LIMIT 40
  `;
  return rows.map((r) => r.title);
}

/** Vygeneruje návrhy pro jeden projekt (pokud je čas a dává to smysl). */
export async function generateSuggestionsForProject(project: Project, force = false): Promise<void> {
  const a = autonomy(project);
  if (a.proactive === false) return; // opt-out (default zapnuto)
  if (project.status !== "active") return;

  const cadenceH = a.cadenceHours && a.cadenceHours > 0 ? a.cadenceHours : DEFAULT_CADENCE_H;
  // force=true (nečinný projekt z příjmu návrhů) obejde kadenci — ať farma nezůstane bez práce.
  if (!force && !(await cadenceElapsed(project.id, cadenceH))) return;
  if ((await openTaskCount(project.id)) >= DROWNING_OPEN_TASKS) return;

  // Kredity — návrhy stojí LLM volání; bez kreditu je negenerujeme.
  const credit = await creditBalance(project.userId).catch(() => null);
  if (credit && !credit.ok) return;

  const max = a.maxSuggestionsPerRound && a.maxSuggestionsPerRound > 0 ? a.maxSuggestionsPerRound : DEFAULT_MAX_SUGGESTIONS;

  const identity = await ensureProjectIdentity(project);
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
        managerNote: project.managerNote?.trim() || undefined,
        maxSuggestions: max,
        projectIdentity: identity,
        repoFacts: (await gatherRepoState(project.id).catch(() => "")).slice(0, STRATEGIST_REPO_FACTS_CHARS),
        knownWork: await knownWorkTitles(project.id),
      }),
      validate: validateStrategy,
      metadata: { userId: project.userId, projectId: project.id, scope: "system" },
    });
    out = res.data;
  } catch (err) {
    console.error(`[suggestions] strategist projektu ${project.id} selhal:`, err);
    return;
  }

  // Návrh bez dokladu z repa se zahazuje už tady — to byl zdroj halucinací.
  const grounded = withEvidence(out.suggestions);
  const withoutEvidence = out.suggestions.length - grounded.length;
  let inserted = 0;
  let duplicates = 0;
  for (const s of grounded.slice(0, max)) {
    const title = s.title.trim();
    if (!title) continue;
    const description = s.description.trim();
    // Stejná deduplikace jako supervisor a příjem návrhů. Vložený návrh je hned
    // v korpusu, takže se chytí i duplicita uvnitř jedné dávky.
    const known = await isKnownWork(project.id, title, description);
    if (known.known) {
      duplicates++;
      continue;
    }

    const row = await getDb()
      .insert(suggestions)
      .values({
        userId: project.userId,
        projectId: project.id,
        kind: normalizeKind(s.kind),
        title,
        description,
        rationale: joinRationale(s.rationale, s.evidence),
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
      message: `Farma má nový nápad: ${title}`,
      data: { title, kind: normalizeKind(s.kind), suggestionId: id },
    });
  }

  await logEvent({
    projectId: project.id,
    type: "suggestions_generated",
    message:
      `Vygenerováno ${czCount(inserted, ["nový návrh", "nové návrhy", "nových návrhů"])}` +
      ` (duplicit ${duplicates}, bez dokladu z repozitáře ${withoutEvidence}).`,
    data: { count: inserted, duplicates, withoutEvidence },
  });
}

function normalizeKind(kind: string): SuggestionKind {
  // Strategist validátor už zaručil, že kind je z povolené množiny (lowercase).
  return kind.trim().toLowerCase() as SuggestionKind;
}

/** Z návrhu vytvoří přání přes jedinou sdílenou implementaci. Vrací id přání. */
export async function convertSuggestionToWish(
  suggestionId: string,
  source: ConvertSuggestionSource = "autopilot",
): Promise<string | null> {
  const res = await convertInDb(getDb(), suggestionId, { source });
  return res.ok ? res.wishId : null;
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

// --- Příjem návrhů: rozhodovací tabulka (čistá, testovaná) -------------------

export type SuggestionDismissReason = "cross_project" | "no_project" | "project_paused" | "duplicate";
export type SuggestionDeferReason = "open_work" | "daily_limit" | "dedup_pending";

export type SuggestionIntakeDecision =
  | { action: "dismiss"; reason: SuggestionDismissReason }
  | { action: "defer"; reason: SuggestionDeferReason }
  | { action: "convert"; reason: "converted" };

export type ProjectMention =
  | { kind: "none" }
  | { kind: "one"; projectId: string }
  | { kind: "many"; projectIds: string[] };

/**
 * Najde projekty zmíněné v titulku a popisu návrhu (celým slovem, bez ohledu na
 * diakritiku a velikost písmen). Používá se jen u návrhů bez project_id.
 */
export function mapSuggestionProject(
  title: string,
  description: string,
  candidates: readonly { id: string; name: string }[],
): ProjectMention {
  const text = ` ${normalize(`${title} ${description}`)} `;
  const ids = [
    ...new Set(
      candidates
        .filter((p) => {
          const name = normalize(p.name);
          return name.length >= 2 && text.includes(` ${name} `);
        })
        .map((p) => p.id),
    ),
  ];
  if (ids.length === 0) return { kind: "none" };
  if (ids.length === 1) return { kind: "one", projectId: ids[0]! };
  return { kind: "many", projectIds: ids };
}

export interface SuggestionIntakeInput {
  /** Projekt návrhu (z generátoru, nebo namapovaný podle jmen). */
  projectId: string | null;
  /** Výsledek mapování jmen; null = návrh měl project_id už od generátoru. */
  mention: ProjectMention["kind"] | null;
  /** Stav projektu; null = projekt neexistuje nebo nepatří autorovi návrhu. */
  projectStatus: ProjectStatus | null;
  /** Výsledek isKnownWork; null = nepočítalo se. */
  dedup: Pick<KnownWorkResult, "known" | "uncertain"> | null;
  hasOpenWork: boolean;
  autoWishesToday: number;
  maxAutoWishesPerDay: number;
}

/**
 * Pořadí je závazné: projekt → pozastavený projekt → duplicita → limity → zadání.
 * Duplicita má přednost před limity (duplicita se zahodí hned, nečeká ve frontě),
 * ale nejistá duplicita se neodhaduje — návrh počká na příští kolo.
 */
export function decideSuggestion(input: SuggestionIntakeInput): SuggestionIntakeDecision {
  if (!input.projectId) {
    return { action: "dismiss", reason: input.mention === "many" ? "cross_project" : "no_project" };
  }
  if (!input.projectStatus) return { action: "dismiss", reason: "no_project" };
  if (input.projectStatus !== "active") return { action: "dismiss", reason: "project_paused" };

  const limit: SuggestionDeferReason | null = input.hasOpenWork
    ? "open_work"
    : input.autoWishesToday >= input.maxAutoWishesPerDay
      ? "daily_limit"
      : null;

  if (!input.dedup || input.dedup.uncertain) return { action: "defer", reason: limit ?? "dedup_pending" };
  if (input.dedup.known) return { action: "dismiss", reason: "duplicate" };
  if (limit) return { action: "defer", reason: limit };
  return { action: "convert", reason: "converted" };
}

/** Hodnota farm_settings.max_auto_wishes_per_day → nezáporné celé číslo, jinak výchozí 2. */
export function parseMaxAutoWishes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_AUTO_WISHES_PER_DAY;
}

const DISMISS_MESSAGE: Record<Exclude<SuggestionDismissReason, "duplicate">, string> = {
  cross_project: "týká se víc projektů najednou — práci napříč projekty farma sama nezakládá",
  no_project: "nepatří k žádnému projektu",
  project_paused: "projekt je pozastavený — do pozastaveného projektu farma práci nezakládá",
};

function dismissMessage(title: string, reason: SuggestionDismissReason, dedup: KnownWorkResult | null): string {
  if (reason === "duplicate") {
    const ref = dedup?.reason && dedup.refTitle ? ` (${knownWorkKindLabel(dedup.reason)} „${dedup.refTitle}“)` : "";
    return `Farma zahodila návrh „${title}“: stejná práce už existuje${ref}.`;
  }
  return `Farma zahodila návrh „${title}“: ${DISMISS_MESSAGE[reason]}.`;
}

async function maxAutoWishesPerDay(): Promise<number> {
  return parseMaxAutoWishes(await getSetting<unknown>("max_auto_wishes_per_day", DEFAULT_MAX_AUTO_WISHES_PER_DAY));
}

/** Kolik přání farma do projektu sama zadala od začátku dne (UTC). */
async function autoWishesToday(projectId: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wishes
    WHERE project_id = ${projectId}
      AND source = 'autopilot'
      AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  `;
  return rows[0]?.n ?? 0;
}

type SuggestionRow = typeof suggestions.$inferSelect;

async function applyIntakeDecision(
  s: SuggestionRow,
  decision: SuggestionIntakeDecision,
  projectId: string | null,
  dedup: KnownWorkResult | null,
): Promise<void> {
  if (decision.action === "defer") return;

  if (decision.action === "dismiss") {
    const updated = await getDb()
      .update(suggestions)
      .set({ status: "dismissed", decidedAt: new Date(), decidedReason: decision.reason })
      .where(and(eq(suggestions.id, s.id), eq(suggestions.status, "new")))
      .returning({ id: suggestions.id });
    if (updated.length === 0) return; // mezitím rozhodl člověk
    await logEvent({
      projectId,
      type: "suggestion_dismissed",
      message: dismissMessage(s.title, decision.reason, dedup),
      data: {
        suggestionId: s.id,
        title: s.title,
        reason: decision.reason,
        ...(decision.reason === "duplicate" && dedup
          ? { refKind: dedup.reason, refId: dedup.refId, refTitle: dedup.refTitle, score: dedup.score, via: dedup.via }
          : {}),
      },
    });
    return;
  }

  const res = await convertInDb(getDb(), s.id, { source: "autopilot" });
  // Projekt se mezi čtením a převodem pozastavil → stejné rozhodnutí jako výš.
  if (!res.ok && res.reason === "project_paused") {
    await applyIntakeDecision(s, { action: "dismiss", reason: "project_paused" }, projectId, null);
  }
}

/**
 * AUTOMATICKÝ PŘÍJEM NÁVRHŮ (suggestion intake).
 *
 * Jméno `runSelfRunOnce` zůstává schválně: pod ním je smyčka „self-run"
 * zaregistrovaná v index.ts a přejmenování by znamenalo sahat do cizího souboru
 * i měnit jméno smyčky v logu. Starý self-run (opt-in přes autonomy.selfRun,
 * jeden návrh za minutu bez deduplikace a limitů, převáděl i do pozastavených
 * projektů) už neexistuje — převod je jediné chování farmy.
 *
 * Pro každý nový návrh (nejstarší první):
 *  a) projekt — bez project_id se namapuje podle jmen; víc projektů = cross_project,
 *     žádný = no_project;
 *  b) pozastavený projekt → zahodit (project_paused);
 *  c) duplicita přes isKnownWork → zahodit (duplicate) s odkazem na původní práci;
 *  d) limity — max přání za den na projekt a žádná rozdělaná práce; jinak návrh
 *     zůstane `new` na příště;
 *  e) jinak ho zadat jako přání (source 'autopilot').
 * Každé rozhodnutí = jedna událost s českým důvodem („Co farma sama zadala").
 */
export async function runSelfRunOnce(): Promise<void> {
  // Smyčka je v index.ts za `pausable` (owner_pause, pauzy i stropy); tady je to
  // jen pojistka pro přímé volání.
  if (!(await shouldFarmRun())) return;

  const maxPerDay = await maxAutoWishesPerDay();
  const pending = await getDb()
    .select()
    .from(suggestions)
    .where(eq(suggestions.status, "new"))
    .orderBy(asc(suggestions.createdAt))
    .limit(INTAKE_BATCH);

  if (pending.length > 0) {
    const allProjects = await getDb()
      .select({ id: projects.id, userId: projects.userId, name: projects.name, status: projects.status })
      .from(projects);
    const openWork = new Map<string, boolean>();
    const autoToday = new Map<string, number>();
    let semanticBudget = SEMANTIC_CALLS_PER_ROUND;

    for (const s of pending) {
      try {
        const userProjects = allProjects.filter((p) => p.userId === s.userId);
        let projectId = s.projectId;
        let mention: ProjectMention["kind"] | null = null;
        if (!projectId) {
          const m = mapSuggestionProject(s.title, s.description, userProjects);
          mention = m.kind;
          if (m.kind === "one") projectId = m.projectId;
        }
        const project = projectId ? (userProjects.find((p) => p.id === projectId) ?? null) : null;

        // Namapovaný projekt si návrh zapamatuje (další kola už nemapují).
        if (!s.projectId && project) {
          await getDb()
            .update(suggestions)
            .set({ projectId: project.id })
            .where(and(eq(suggestions.id, s.id), eq(suggestions.status, "new")));
        }

        let dedup: KnownWorkResult | null = null;
        let open = false;
        let today = 0;
        if (project && project.status === "active") {
          if (!openWork.has(project.id)) openWork.set(project.id, await hasOpenWork(project.id));
          if (!autoToday.has(project.id)) autoToday.set(project.id, await autoWishesToday(project.id));
          open = openWork.get(project.id) ?? true;
          today = autoToday.get(project.id) ?? maxPerDay;
          const canAccept = !open && today < maxPerDay;
          // Placený model se ptá jen tam, kde by návrh opravdu mohl projít.
          dedup = await isKnownWork(project.id, s.title, s.description, {
            excludeSuggestionId: s.id,
            createdBefore: s.createdAt,
            semantic: canAccept && semanticBudget > 0,
            onSemanticCall: () => {
              semanticBudget--;
            },
          });
        }

        const decision = decideSuggestion({
          projectId: project?.id ?? null,
          mention,
          projectStatus: project?.status ?? null,
          dedup,
          hasOpenWork: open,
          autoWishesToday: today,
          maxAutoWishesPerDay: maxPerDay,
        });
        await applyIntakeDecision(s, decision, project?.id ?? null, dedup);
        if (decision.action === "convert" && project) {
          openWork.set(project.id, true);
          autoToday.set(project.id, today + 1);
        }
      } catch (err) {
        console.error(`[intake] návrh ${s.id} selhal:`, err);
      }
    }
  }

  await refillIdleProjects();
}

/**
 * Nečinný aktivní projekt (žádná rozdělaná práce, žádný nový návrh) si vynutí
 * čerstvé návrhy mimo kadenci, ať farma nestojí bez práce. Nejvýš jednou za
 * IDLE_REFILL_MIN_H — kdyby strategist vracel jen duplicity, jinak by se ptal
 * každou minutu a pálil tokeny.
 */
async function refillIdleProjects(): Promise<void> {
  const active = await getDb().select().from(projects).where(eq(projects.status, "active"));
  for (const p of active) {
    try {
      if (autonomy(p).proactive === false) continue;
      if (await hasOpenWork(p.id)) continue;
      const news = await getDb()
        .select({ id: suggestions.id })
        .from(suggestions)
        .where(and(eq(suggestions.projectId, p.id), eq(suggestions.status, "new")))
        .limit(1);
      if (news.length > 0) continue;
      if (!(await cadenceElapsed(p.id, IDLE_REFILL_MIN_H))) continue;
      await generateSuggestionsForProject(p, true);
    } catch (err) {
      console.error(`[intake] návrhy pro nečinný projekt ${p.id} selhaly:`, err);
    }
  }
}
