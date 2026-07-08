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

/** Loop detection: je výstup příliš podobný některému z předchozích? */
export function isLoopingOutput(
  candidate: string,
  previousOutputs: string[],
  threshold: number,
): boolean {
  return previousOutputs.some((prev) => similarity(candidate, prev) >= threshold);
}
