/**
 * Dlouhé seznamy na stránce: prvních N hned, zbytek pod „Zobrazit vše (N)".
 *
 * Proč: detail projektu měl 26 038 px — Mozek projektu vypisoval 65 záznamů
 * i s 5 000znakovými texty architektury, „Všechna přání" 100 řádků a živé
 * události 40 skupin. Nic z toho se nemaže, jen se to nerozbaluje samo.
 *
 * Bez importů — testuje se přes `tsx --test`.
 */

export function splitVisible<T>(items: readonly T[], initial: number): { visible: T[]; rest: T[] } {
  const n = Number.isFinite(initial) && initial > 0 ? Math.floor(initial) : 0;
  // Schovat jedinou položku pod „Zobrazit vše" nemá smysl — ukážeme ji rovnou.
  if (items.length <= n + 1) return { visible: [...items], rest: [] };
  return { visible: items.slice(0, n), rest: items.slice(n) };
}

/** Hranice, od které se text záznamu sbalí (znaky nebo řádky). */
export const DLOUHY_TEXT_ZNAKU = 320;
export const DLOUHY_TEXT_RADKU = 5;

/** Je text tak dlouhý, že ho má smysl sbalit na pár řádků? */
export function isLongText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.length > DLOUHY_TEXT_ZNAKU || text.split("\n").length > DLOUHY_TEXT_RADKU;
}
