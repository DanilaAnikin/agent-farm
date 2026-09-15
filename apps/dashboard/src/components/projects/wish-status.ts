/**
 * Odvozený stav přání PRO ZOBRAZENÍ.
 *
 * Proč: `wishes.status = 'active'` v pozastaveném projektu svítil zeleně jako
 * „Aktivní" s 0 %, přestože na přání nikdo nepracoval a pracovat nebude, dokud
 * projekt nepoběží. Databázový stav říká, kde je přání v životním cyklu; člověk
 * potřebuje vědět, jestli se na něm DOOPRAVDY pracuje, a když ne, proč.
 *
 * Pořadí pravidel JE priorita: nejdřív konečné stavy, pak to, co práci blokuje
 * zvenku (projekt, rozpočet, farma), a teprve nakonec vnitřní stav přání.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */

export type WishTone = "ok" | "warn" | "danger" | "info" | "neutral" | "violet";

export interface EffectiveWishStatus {
  label: string;
  tone: WishTone;
  /** Krátké vysvětlení pro title/tooltip, když stav není samozřejmý. */
  hint: string | null;
}

export interface WishStatusInput {
  status: string;
}

export interface ProjectStatusInput {
  status: string;
}

export interface FarmStatusInput {
  /** Farma globálně stojí (vypínač majitele, rozpočet, levné hodiny…). */
  paused: boolean;
}

/** Počty úkolů přání. `running` zahrnuje i posuzování a slučování. */
export interface WishTaskCounts {
  queued: number;
  running: number;
  parked: number;
  total: number;
}

export function effectiveWishStatus(
  wish: WishStatusInput,
  project: ProjectStatusInput,
  farm: FarmStatusInput,
  counts: WishTaskCounts,
): EffectiveWishStatus {
  // 1) konečné stavy — nic dalšího je nezmění
  if (wish.status === "done") return { label: "Hotovo", tone: "ok", hint: null };
  if (wish.status === "parked") {
    return {
      label: "Zaparkováno",
      tone: "neutral",
      hint: "Na přání se nepracuje; farma ho sama znovu neotevře.",
    };
  }

  // 2) projekt stojí — přání počká, i kdyby farma běžela
  if (project.status === "paused" || project.status === "stopped") {
    return {
      label: "Stojí (projekt pozastaven)",
      tone: "neutral",
      hint:
        project.status === "stopped"
          ? "Projekt čeká v rolloutu, přání počká na jeho zapnutí."
          : "Projekt je pozastavený, přání počká.",
    };
  }
  if (project.status === "budget_hold") {
    return {
      label: "Čeká na rozpočet",
      tone: "warn",
      hint: "Projekt vyčerpal svůj strop, pokračuje po resetu okna.",
    };
  }

  // 3) farma stojí
  if (farm.paused) {
    return {
      label: "Čeká na spuštění farmy",
      tone: "neutral",
      hint: "Projekt běží, ale farma je teď pozastavená.",
    };
  }

  // 4) vnitřní stav přání
  if (wish.status === "new") {
    return { label: "Čeká na zpracování manažerem", tone: "info", hint: null };
  }
  if (wish.status === "specifying") {
    return { label: "Připravuje se specifikace", tone: "info", hint: null };
  }
  if (wish.status === "awaiting_spec_approval") {
    return { label: "Specifikace ke schválení", tone: "info", hint: null };
  }

  const zije = counts.queued + counts.running;
  if (counts.total > 0 && zije === 0 && counts.parked >= counts.total) {
    return {
      label: "Zablokováno",
      tone: "warn",
      hint: "Všechny úkoly přání jsou zaparkované a nic dalšího nečeká ve frontě.",
    };
  }
  return { label: "Rozpracováno", tone: "info", hint: null };
}
