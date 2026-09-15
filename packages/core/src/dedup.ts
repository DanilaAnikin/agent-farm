/**
 * Normalizace a trigram podobnost pro:
 *  - refill dedup (nový task vs. parked/failed tasky projektu)
 *  - loop detection (výstup pokusu vs. předchozí pokusy téhož tasku)
 * Stejný algoritmus jako pg_trgm (Dice koeficient na trigramech), aby JS a DB
 * daly konzistentní výsledky.
 */

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // diakritika
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(text: string): Set<string> {
  const padded = `  ${normalize(text)} `;
  const set = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** Dice koeficient na trigramech: 0 (různé) až 1 (shodné). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Klíč pro mechanický dedup úkolu: normalizovaný title + done_condition. */
export function taskDedupKey(title: string, doneCondition: string): string {
  return normalize(`${title} ${doneCondition}`);
}

/** Je nový úkol duplikátem některého existujícího (dle prahu)? */
export function isDuplicate(
  candidateKey: string,
  existingKeys: string[],
  threshold: number,
): boolean {
  return existingKeys.some((k) => similarity(candidateKey, k) >= threshold);
}

// --- Deduplikace PRÁCE (návrhy, přání, úkoly) --------------------------------
//
// Dřív se návrh porovnával jen titulkem s prahem 0,8 a supervisor neporovnával
// vůbec, takže farma navrhovala totéž pořád dokola jinými slovy. Práce se proto
// porovnává přes titulek I popis. Čistý trigram ale neuvidí, že „Monitoring chyb
// přes Sentry" a „Napojit Sentry" je totéž (vychází ~0,35) — pásmo mezi
// WORK_DEDUP_UNRELATED a WORK_DEDUP_CERTAIN proto rozhoduje levný model.

/** Od tohoto skóre je shoda mechanicky „známá práce" (když model nerozhoduje). */
export const WORK_DEDUP_THRESHOLD = 0.55;
/** Nad tímto skóre je shoda jistá — model se neptá. */
export const WORK_DEDUP_CERTAIN = 0.8;
/** Pod tímto skóre je jisté, že nejde o totéž — model se neptá. */
export const WORK_DEDUP_UNRELATED = 0.3;

/** Kolik znaků popisu se porovnává. Dlouhý popis by jinak přehlušil krátký titulek. */
const WORK_DESCRIPTION_CHARS = 600;

export interface WorkText {
  title: string;
  description?: string | null;
}

/** Normalizovaný text práce: titulek + začátek popisu, bez diakritiky a interpunkce. */
export function normalizeWork(title: string, description?: string | null): string {
  const desc = (description ?? "").slice(0, WORK_DESCRIPTION_CHARS);
  return normalize(`${title ?? ""} ${desc}`);
}

/**
 * Podobnost dvou kusů práce 0..1. Bere vyšší z (titulek+popis) a (jen titulek) —
 * u krátkého zadání bez popisu proti dlouhému popisu by jinak skóre uměle klesalo.
 * Prázdná práce není podobná ničemu (dva prázdné vstupy nejsou „stejná práce").
 */
export function workSimilarity(a: WorkText, b: WorkText): number {
  const fullA = normalizeWork(a.title, a.description);
  const fullB = normalizeWork(b.title, b.description);
  if (!fullA || !fullB) return 0;
  const full = similarity(fullA, fullB);
  const titleA = normalize(a.title ?? "");
  const titleB = normalize(b.title ?? "");
  const titles = titleA && titleB ? similarity(titleA, titleB) : 0;
  return Math.max(full, titles);
}

/** Seřadí korpus podle podobnosti s kandidátem (nejbližší první), nejvýš `limit` položek. */
export function rankSimilarWork<T extends WorkText>(
  candidate: WorkText,
  corpus: readonly T[],
  limit = 20,
): { item: T; score: number }[] {
  return corpus
    .map((item) => ({ item, score: workSimilarity(candidate, item) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, limit));
}

export type WorkScoreClass = "known" | "unknown" | "uncertain";

/** Jistě známá (> 0,8), jistě nová (< 0,3), jinak nejisté pásmo pro model. */
export function classifyWorkScore(score: number): WorkScoreClass {
  if (score > WORK_DEDUP_CERTAIN) return "known";
  if (score < WORK_DEDUP_UNRELATED) return "unknown";
  return "uncertain";
}

/** Loop detection: je výstup příliš podobný některému z předchozích? */
export function isLoopingOutput(
  candidate: string,
  previousOutputs: string[],
  threshold: number,
): boolean {
  return previousOutputs.some((prev) => similarity(candidate, prev) >= threshold);
}
