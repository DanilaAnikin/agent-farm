/** Chyba znamenající, že byl vyčerpán rozpočet (429 / budget). NENÍ selhání úkolu. */
export class BudgetExceededError extends Error {
  readonly scope: "farm_month" | "farm" | "user" | "project" | "wish" | "attempt";
  constructor(scope: BudgetExceededError["scope"], message?: string) {
    super(message ?? `Budget exceeded at scope: ${scope}`);
    this.name = "BudgetExceededError";
    this.scope = scope;
  }
}

/** Neplatný přechod stavového stroje. */
export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Úkol byl zaparkován (vyžaduje lidský zásah). */
export class TaskParkedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskParkedError";
  }
}
