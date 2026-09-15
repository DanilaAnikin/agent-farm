/**
 * SPOLEČNÁ DEDUPLIKACE PRÁCE — jediná odpověď na otázku „tohle už farma dělá
 * nebo dělala?". Volá ji strategist, supervisor i příjem návrhů (suggestions.ts).
 *
 * Dřív supervisor neporovnával vůbec a strategist jen titulek s prahem 0,8 proti
 * pár otevřeným návrhům, takže farma navrhovala tutéž práci znovu a znovu.
 *
 * KORPUS: všechna přání projektu v jakémkoli stavu, všechny úkoly (včetně
 * archivovaných parked), návrhy converted/dismissed/accepted za 120 dní a nové
 * návrhy. Návrhy zahozené jako duplicita se nepočítají — jinak by se dva
 * podobné nové návrhy navzájem shodily a nepřežil by ani originál.
 *
 * DVĚ VRSTVY:
 *  1. mechanická — trigram nad titulkem + popisem (packages/core);
 *  2. sémantická — JEDNO levné volání (alias `cheap`) nad ~20 nejbližšími titulky.
 *     Běží jen v nejistém pásmu 0,3–0,8, jen když farma smí pracovat
 *     (`shouldFarmRun`) a jen když to volající dovolí. Jinak rozhodne práh 0,55
 *     a výsledek nese `uncertain: true`, ať volající může rozhodnutí odložit.
 *     Neúspěch modelu se pamatuje (30 min pauza, po 3 neúspěších rozhodne práh)
 *     a placených volání je nejvýš SEMANTIC_CALLS_PER_DAY denně.
 */
import { getDb, getSql, projects } from "@farm/db";
import { eq } from "drizzle-orm";
import { WORK_DEDUP_THRESHOLD, classifyWorkScore, normalizeWork, rankSimilarWork } from "@farm/core";
import { MODELS, structured, validateWorkDedup, workDedupPrompt } from "@farm/llm";
import type { WorkDedupOutput } from "@farm/llm";
import { shouldFarmRun } from "./settings.js";

export type KnownWorkKind = "wish" | "task" | "suggestion";

export interface WorkCorpusItem {
  kind: KnownWorkKind;
  id: string;
  title: string;
  description: string;
}

export interface KnownWorkResult {
  known: boolean;
  reason?: KnownWorkKind;
  refId?: string;
  refTitle?: string;
  score?: number;
  via?: "mechanical" | "semantic";
  /** Sémantická vrstva byla potřeba, ale neběžela — rozhodl jen práh. */
  uncertain?: boolean;
}

export interface KnownWorkOptions {
  /** Návrh, který se právě posuzuje — nesmí se najít sám v sobě. */
  excludeSuggestionId?: string;
  /** Nové návrhy se počítají jen starší než tenhle okamžik (starší vyhrává). */
  createdBefore?: Date;
  /** false = nevolat model ani v nejistém pásmu (výsledek pak nese uncertain). */
  semantic?: boolean;
  /** Zavolá se těsně před placeným voláním modelu (strop volání za kolo). */
  onSemanticCall?: () => void;
}

const SUGGESTION_WINDOW_DAYS = 120;
const SEMANTIC_CANDIDATES = 20;
const SEMANTIC_CACHE_TTL_MS = 6 * 3_600_000;
const SEMANTIC_CACHE_MAX = 500;

/** Po neúspěšném volání modelu se na tutéž otázku čeká tak dlouho (negativní cache). */
export const SEMANTIC_FAILURE_BACKOFF_MS = 30 * 60_000;
/** Po tolika neúspěších se o téže otázce rozhodne mechanickým prahem (bez modelu). */
export const SEMANTIC_MAX_FAILURES = 3;
/** Strop placených sémantických kontrol za den (UTC) — pojistka proti smyčce chyb. */
export const SEMANTIC_CALLS_PER_DAY = Number(process.env.WORK_DEDUP_SEMANTIC_CALLS_PER_DAY ?? 60);

export type SemanticAttempt = "call" | "wait" | "mechanical";

export interface SemanticAttemptState {
  /** Kolikrát už model u téhle otázky selhal. */
  failures: number;
  /** Kdy naposledy selhal (ms); null = zatím nikdy. */
  lastFailureAt: number | null;
  /** Kolik placených volání už dnes proběhlo. */
  callsToday: number;
  now: number;
}

/**
 * Smí se model zeptat? Dřív se po chybě nic neuložilo, návrh zůstal „nejistý",
 * intake ho odložil a za minutu se ptal znovu — při trvalé chybě modelu až tři
 * placená volání za minutu bez konce.
 *  - call: zeptat se,
 *  - wait: teď ne (čerstvá chyba nebo denní strop) — výsledek zůstane nejistý,
 *  - mechanical: model opakovaně selhal — rozhodne mechanický práh.
 */
export function semanticAttempt(
  s: SemanticAttemptState,
  limits: { maxFailures?: number; backoffMs?: number; callsPerDay?: number } = {},
): SemanticAttempt {
  if (s.failures >= (limits.maxFailures ?? SEMANTIC_MAX_FAILURES)) return "mechanical";
  if (s.lastFailureAt !== null && s.now - s.lastFailureAt < (limits.backoffMs ?? SEMANTIC_FAILURE_BACKOFF_MS)) {
    return "wait";
  }
  if (s.callsToday >= (limits.callsPerDay ?? SEMANTIC_CALLS_PER_DAY)) return "wait";
  return "call";
}

const KIND_LABEL: Record<KnownWorkKind, string> = {
  wish: "přání",
  task: "úkol",
  suggestion: "návrh",
};

export function knownWorkKindLabel(kind: KnownWorkKind): string {
  return KIND_LABEL[kind];
}

// Odložený návrh se posuzuje každou minutu znovu; bez paměti by se model ptal
// pořád dokola na totéž. Klíč obsahuje velikost korpusu — když přibude práce,
// otázka se položí znovu.
const semanticCache = new Map<string, { at: number; result: KnownWorkResult }>();
// Negativní cache: neúspěchy modelu podle stejného klíče jako semanticCache.
const semanticFailures = new Map<string, { count: number; at: number }>();
// Počítadlo placených volání za den (UTC) v tomhle procesu.
let semanticCalls = { day: "", count: 0 };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Načte korpus známé práce projektu (viz hlavička souboru). */
export async function loadWorkCorpus(projectId: string, opts: KnownWorkOptions = {}): Promise<WorkCorpusItem[]> {
  const sql = getSql();
  const excludeClause = opts.excludeSuggestionId ? sql`AND id <> ${opts.excludeSuggestionId}` : sql``;
  const newClause = opts.createdBefore
    ? sql`(status = 'new' AND created_at < ${opts.createdBefore})`
    : sql`status = 'new'`;
  const [wishRows, taskRows, suggestionRows] = await Promise.all([
    sql<{ id: string; title: string; description: string }[]>`
      SELECT id, title, description FROM wishes WHERE project_id = ${projectId}
    `,
    // Úkoly se porovnávají titulkem + done_condition (stejně jako tasks.dedup_key).
    sql<{ id: string; title: string; description: string }[]>`
      SELECT id, title, done_condition AS description FROM tasks WHERE project_id = ${projectId}
    `,
    sql<{ id: string; title: string; description: string }[]>`
      SELECT id, title, description FROM suggestions
      WHERE project_id = ${projectId} ${excludeClause}
        AND (
          (status IN ('converted', 'dismissed', 'accepted')
            AND coalesce(decided_at, created_at) >= now() - make_interval(days => ${SUGGESTION_WINDOW_DAYS})
            AND coalesce(decided_reason, '') <> 'duplicate')
          OR ${newClause}
        )
    `,
  ]);
  return [
    ...wishRows.map((r) => ({ kind: "wish" as const, id: r.id, title: r.title, description: r.description ?? "" })),
    ...taskRows.map((r) => ({ kind: "task" as const, id: r.id, title: r.title, description: r.description ?? "" })),
    ...suggestionRows.map((r) => ({
      kind: "suggestion" as const,
      id: r.id,
      title: r.title,
      description: r.description ?? "",
    })),
  ];
}

function hit(item: WorkCorpusItem, score: number, via: "mechanical" | "semantic"): KnownWorkResult {
  return { known: true, reason: item.kind, refId: item.id, refTitle: item.title, score, via };
}

/** Je tahle práce v projektu už známá? Viz hlavička souboru. */
export async function isKnownWork(
  projectId: string,
  title: string,
  description: string | null | undefined,
  opts: KnownWorkOptions = {},
): Promise<KnownWorkResult> {
  const candidate = { title, description: description ?? "" };
  const normalized = normalizeWork(candidate.title, candidate.description);
  if (!normalized) return { known: false, score: 0, via: "mechanical" };

  const corpus = await loadWorkCorpus(projectId, opts);
  const ranked = rankSimilarWork(candidate, corpus, SEMANTIC_CANDIDATES);
  const best = ranked[0];
  if (!best) return { known: false, score: 0, via: "mechanical" };

  const cls = classifyWorkScore(best.score);
  if (cls === "known") return hit(best.item, best.score, "mechanical");
  if (cls === "unknown") return { known: false, score: best.score, via: "mechanical" };

  // Nejisté pásmo: když model nerozhodne, platí mechanický práh.
  const fallback: KnownWorkResult =
    best.score >= WORK_DEDUP_THRESHOLD
      ? hit(best.item, best.score, "mechanical")
      : { known: false, score: best.score, via: "mechanical" };

  const cacheKey = `${projectId}|${corpus.length}|${normalized}`;
  const cached = semanticCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEMANTIC_CACHE_TTL_MS) return cached.result;

  if (opts.semantic === false || !(await shouldFarmRun())) return { ...fallback, uncertain: true };

  const now = Date.now();
  if (semanticCalls.day !== utcDay(now)) semanticCalls = { day: utcDay(now), count: 0 };
  const failure = semanticFailures.get(cacheKey);
  const attempt = semanticAttempt({
    failures: failure?.count ?? 0,
    lastFailureAt: failure?.at ?? null,
    callsToday: semanticCalls.count,
    now,
  });
  if (attempt === "mechanical") return fallback;
  if (attempt === "wait") return { ...fallback, uncertain: true };

  try {
    opts.onSemanticCall?.();
    semanticCalls.count++;
    const owner = await getDb()
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const res = await structured<WorkDedupOutput>({
      model: MODELS.cheap,
      messages: workDedupPrompt({
        candidate,
        existing: ranked.map((r) => ({ title: r.item.title, kind: KIND_LABEL[r.item.kind] })),
      }),
      validate: validateWorkDedup,
      temperature: 0,
      maxTokens: 300,
      metadata: { userId: owner[0]?.userId, projectId, scope: "system" },
    });
    const idx = res.data.match;
    const matched = idx !== null && idx < ranked.length ? ranked[idx] : undefined;
    const result: KnownWorkResult = matched
      ? hit(matched.item, matched.score, "semantic")
      : { known: false, score: best.score, via: "semantic" };
    if (semanticCache.size >= SEMANTIC_CACHE_MAX) semanticCache.clear();
    semanticCache.set(cacheKey, { at: Date.now(), result });
    semanticFailures.delete(cacheKey);
    return result;
  } catch (err) {
    console.error(`[work-dedup] sémantická kontrola projektu ${projectId} selhala:`, String(err).slice(0, 200));
    if (semanticFailures.size >= SEMANTIC_CACHE_MAX) semanticFailures.clear();
    semanticFailures.set(cacheKey, { count: (failure?.count ?? 0) + 1, at: Date.now() });
    return { ...fallback, uncertain: true };
  }
}
