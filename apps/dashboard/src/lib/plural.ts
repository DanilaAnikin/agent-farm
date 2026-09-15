/**
 * České plurály. Čeština má tři tvary a dashboard je dosud neřešil vůbec —
 * v UI se objevovalo „1 workerů", „2 úkolů", „5 agenti".
 *
 * `Intl.PluralRules('cs')` vrací čtyři kategorie: one (1), few (2–4),
 * many (desetinná čísla) a other (0, 5+). Pro celá čísla se `many` nikdy
 * neobjeví a `other` je tvar genitivu množného („workerů"), takže obě
 * mapujeme na TŘETÍ tvar. Volající tedy píše jen [1., 2.–4., 5.+].
 *
 * Bez importů a bez `@/` — testuje se přes `tsx --test`.
 */

const PRAVIDLA = new Intl.PluralRules("cs");

/** Tři tvary: [1 workera, 2–4 workery, 5+ workerů]. */
export type PluralForms = readonly [one: string, few: string, many: string];

/** Vrátí správný TVAR SLOVA pro počet (bez čísla). */
export function plural(n: number, forms: PluralForms): string {
  const kategorie = PRAVIDLA.select(Number.isFinite(n) ? n : 0);
  if (kategorie === "one") return forms[0];
  if (kategorie === "few") return forms[1];
  // 'many' (desetinná) i 'other' (0, 5+) používají v češtině stejný tvar.
  return forms[2];
}

/** „2 workery" — číslo i tvar dohromady. */
export function countLabel(n: number, forms: PluralForms): string {
  const cislo = Number.isFinite(n) ? n : 0;
  return `${new Intl.NumberFormat("cs-CZ").format(cislo)} ${plural(cislo, forms)}`;
}

/** Nejčastější tvary na jednom místě, ať se nepíšou pokaždé znovu. */
export const TVARY = {
  ukol: ["úkol", "úkoly", "úkolů"],
  prani: ["přání", "přání", "přání"],
  projekt: ["projekt", "projekty", "projektů"],
  navrh: ["návrh", "návrhy", "návrhů"],
  agent: ["agent", "agenti", "agentů"],
  worker: ["worker", "workery", "workerů"],
  // Role `worker` se v UI jmenuje „Vývojář" (AGENT_ROLE_META) — tenhle tvar patří do textů.
  vyvojar: ["vývojář", "vývojáři", "vývojářů"],
  pokus: ["pokus", "pokusy", "pokusů"],
  udalost: ["událost", "události", "událostí"],
  hodina: ["hodina", "hodiny", "hodin"],
  den: ["den", "dny", "dnů"],
  minuta: ["minuta", "minuty", "minut"],
  polozka: ["položka", "položky", "položek"],
} as const satisfies Record<string, PluralForms>;
