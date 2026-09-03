/**
 * Rozpočtová logika — vrstvené denní stropy a reset okna.
 * Skutečné načtení SUM(cost_ledger) dělají služby; tady jsou čisté funkce.
 */
import { BudgetExceededError } from "./errors.js";

export interface SpendSnapshot {
  /** Útrata celé farmy za probíhající kalendářní měsíc. */
  farmMonthUsd?: number;
  farmTodayUsd: number;
  userTodayUsd: number;
  projectTodayUsd: number;
  wishTotalUsd?: number;
}

export interface CapSet {
  /**
   * Měsíční strop celé farmy. Nejtvrdší hranice, jakou farma má.
   *
   * Denní strop sám o sobě nestačí: 0,60 USD/den je přes 18 USD za měsíc a při
   * jakémkoli přestřelení (a to se dělo, viz `pendingUsd` níž) se přes měsíc
   * nasčítá výrazně víc. Vlastník má limit, který je měsíční, ne denní — tak ho
   * kontroluj přímo, ne oklikou přes denní.
   */
  farmMonthlyCapUsd?: number;
  farmDailyCapUsd: number;
  userDailyCapUsd: number;
  projectDailyCapUsd: number;
  wishBudgetUsd?: number;
}

/**
 * Zjistí, jestli přidání `pendingUsd` překročí některý strop.
 * Vrací scope, který by se překročil (nebo null).
 */
export function checkBudget(
  spend: SpendSnapshot,
  caps: CapSet,
  pendingUsd = 0,
): BudgetExceededError["scope"] | null {
  // Měsíční strop se testuje jako první: je nejtvrdší a jeho překročení nemá
  // smysl přebíjet tím, že dnešní denní okno je zrovna prázdné.
  if (
    caps.farmMonthlyCapUsd !== undefined &&
    spend.farmMonthUsd !== undefined &&
    spend.farmMonthUsd + pendingUsd > caps.farmMonthlyCapUsd
  ) {
    return "farm_month";
  }
  if (spend.farmTodayUsd + pendingUsd > caps.farmDailyCapUsd) return "farm";
  if (spend.userTodayUsd + pendingUsd > caps.userDailyCapUsd) return "user";
  if (spend.projectTodayUsd + pendingUsd > caps.projectDailyCapUsd) return "project";
  if (
    caps.wishBudgetUsd !== undefined &&
    spend.wishTotalUsd !== undefined &&
    spend.wishTotalUsd + pendingUsd > caps.wishBudgetUsd
  ) {
    return "wish";
  }
  return null;
}

export function assertBudget(spend: SpendSnapshot, caps: CapSet, pendingUsd = 0): void {
  const scope = checkBudget(spend, caps, pendingUsd);
  if (scope) throw new BudgetExceededError(scope);
}

/**
 * Vrátí čas příštího resetu denního okna (00:00 v dané TZ).
 * Zjednodušeno na UTC (default); pro jiné TZ použij Intl v service vrstvě.
 */
export function nextResetUtc(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/** Je teď po resetu okna od `heldSince`? (můžeme auto-resume) */
export function shouldAutoResume(heldSince: Date, now: Date): boolean {
  const reset = nextResetUtc(heldSince);
  return now.getTime() >= reset.getTime();
}
