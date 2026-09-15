/**
 * Stav projektu PRO ZOBRAZENÍ — jedna sdílená sada vět pro kartu projektu i detail.
 *
 * Proč: `budget_hold` (automatické čekání na rozpočet, pustí se samo po resetu
 * okna) se v UI vydával za ručně pozastavený projekt — „Projekt je pozastavený."
 * — a sváděl k ručnímu „Spustit". Stejně tak projekt v postupném náběhu
 * (`stopped`) mluvil o „rolloutu".
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */

/** Krátký stav do řádku „… · farma běží". */
export function projectStatusLine(status: string): string {
  switch (status) {
    case "active":
      return "Projekt aktivní";
    case "paused":
      return "Projekt pozastaven";
    case "stopped":
      return "Projekt čeká na postupné zapnutí";
    case "budget_hold":
      return "Projekt čeká na rozpočet";
    default:
      return "Projekt";
  }
}

/** Celá věta, proč projekt nepracuje; null = projekt běží. */
export function projectIdleSentence(status: string): string | null {
  switch (status) {
    case "active":
      return null;
    case "budget_hold":
      return "Projekt čeká na obnovení rozpočtu, pokračuje sám po resetu okna.";
    case "stopped":
      return "Projekt čeká na postupné zapnutí, zapne se sám po kontrolách zdraví.";
    default:
      return "Projekt je pozastavený.";
  }
}

/** Přísudek do věty „3 přání čekají, projekt …". */
export function projectWaitingPredicate(status: string): string {
  switch (status) {
    case "budget_hold":
      return "čeká na obnovení rozpočtu";
    case "stopped":
      return "čeká na postupné zapnutí";
    default:
      return "je pozastavený";
  }
}

/** Nápověda u agentů projektu, který nepracuje; null = projekt běží. */
export function projectAgentHint(status: string): string | null {
  switch (status) {
    case "active":
      return null;
    case "budget_hold":
      return "Projekt čeká na obnovení rozpočtu, agenti na něm zatím nepracují.";
    case "stopped":
      return "Projekt čeká na postupné zapnutí, agenti na něm zatím nepracují.";
    default:
      return "Projekt je pozastavený, agenti na něm nepracují.";
  }
}
