import { isLoopingOutput } from "./dedup.js";

/**
 * Klasifikace chyby z LLM proxy: rozpočet vs. skutečné selhání.
 * KLÍČOVÉ: rozpočtové odmítnutí NESMÍ inkrementovat circuit breaker — vede na
 * budget_hold s auto-resume, ne na parked.
 */
export type ErrorClass = "budget" | "rate_limit" | "failure";

export function classifyModelError(err: unknown): ErrorClass {
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  const msg = (
    (err as { message?: string })?.message ??
    String(err ?? "")
  ).toLowerCase();

  if (
    msg.includes("budget") ||
    msg.includes("exceeded budget") ||
    msg.includes("max_budget") ||
    msg.includes("insufficient") && msg.includes("balance")
  ) {
    return "budget";
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
    // Rate limit řešíme retry/backoffem, ne parkováním; ale ani nefailujeme task.
    return "rate_limit";
  }
  return "failure";
}

/** Rozhodnutí guardrail vrstvy po jednom pokusu. */
export interface AttemptOutcomeInput {
  errorClass?: ErrorClass;
  judgeVerdict?: "approve" | "reject" | "escalate";
  outputSummary?: string;
  previousOutputs: string[];
  attemptsCount: number; // POČET již proběhlých reálných pokusů (bez infra kill)
  maxAttempts: number;
  loopThreshold: number;
}

export type NextAction =
  | { action: "done" }
  | { action: "requeue"; reason: string }
  | { action: "requeue_no_penalty"; reason: string } // infra kill / rate limit
  | { action: "park"; reason: string }
  | { action: "budget_hold"; reason: string };

/** Čistá funkce: co dělat po pokusu. Testovatelná bez DB. */
export function decideNextAction(input: AttemptOutcomeInput): NextAction {
  if (input.errorClass === "budget") {
    return { action: "budget_hold", reason: "Rozpočtový strop dosažen — čeká se na reset okna." };
  }
  if (input.errorClass === "rate_limit") {
    return { action: "requeue_no_penalty", reason: "Rate limit — retry bez penalizace." };
  }
  if (input.errorClass === "failure") {
    return afterRealFailure(input, "Pokus selhal chybou.");
  }

  // Loop detection má přednost — opakující se výstup je churn.
  if (
    input.outputSummary &&
    isLoopingOutput(input.outputSummary, input.previousOutputs, input.loopThreshold)
  ) {
    return { action: "park", reason: "Loop detection: výstup se opakuje, halt." };
  }

  if (input.judgeVerdict === "approve") return { action: "done" };
  if (input.judgeVerdict === "escalate") {
    return { action: "park", reason: "Judge eskaloval na člověka." };
  }
  // reject
  return afterRealFailure(input, "Judge zamítl pokus.");
}

function afterRealFailure(input: AttemptOutcomeInput, reason: string): NextAction {
  if (input.attemptsCount >= input.maxAttempts) {
    return { action: "park", reason: `${reason} Vyčerpány pokusy (${input.maxAttempts}).` };
  }
  return { action: "requeue", reason };
}

/** Circuit breaker: dosáhl počet po sobě jdoucích selhání prahu? */
export function circuitBreakerTripped(
  consecutiveFailures: number,
  threshold: number,
): boolean {
  return consecutiveFailures >= threshold;
}

/** Je pokus mrtvý (heartbeat starší než limit)? Pro reconciliation. */
export function isStaleHeartbeat(heartbeatAt: Date, now: Date, staleMs: number): boolean {
  return now.getTime() - heartbeatAt.getTime() > staleMs;
}

/** Vypršel wall-clock limit pokusu? */
export function isWallClockExceeded(startedAt: Date, now: Date, maxMin: number): boolean {
  return now.getTime() - startedAt.getTime() > maxMin * 60_000;
}
