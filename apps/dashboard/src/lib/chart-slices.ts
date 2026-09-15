/**
 * Drobné položky grafů /costs.
 *
 * Proč: graf „Podle modelu" kreslil sloupec „DeepSeek V4 Flash" s 0,04 US$ vedle
 * 1,81 US$ — vypadal jako nula a čtenář nevěděl, jestli jde o chybu. Položka,
 * která se zaokrouhlí na 0,00 US$, se schová úplně; položka pod `minShare`
 * celku jde z grafu do poznámky pod ním (s částkou, nic se neztratí).
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */

export interface NamedValueLike {
  name: string;
  value: number;
}

/** Hranice zobrazitelné částky (formatUsd zaokrouhluje na centy). */
const NEJMENSI_CASTKA = 0.005;

export function splitMinorSlices<T extends NamedValueLike>(
  items: readonly T[],
  minShare = 0.05,
): { major: T[]; minor: T[]; total: number } {
  const platne = items.filter((i) => Number.isFinite(i.value) && i.value > 0);
  const total = platne.reduce((s, i) => s + i.value, 0);
  const major: T[] = [];
  const minor: T[] = [];
  for (const i of platne) {
    if (i.value < NEJMENSI_CASTKA) continue;
    if (total > 0 && i.value / total >= minShare) major.push(i);
    else minor.push(i);
  }
  return { major, minor, total };
}
