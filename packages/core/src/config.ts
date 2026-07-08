/** Runtime konfigurace farmy. Defaulty z env; za běhu přepisovatelné z farm_settings. */
export interface FarmConfig {
  farmDailyCapUsd: number;
  farmDailyMediaCapUsd: number;
  defaultUserDailyCapUsd: number;
  defaultProjectDailyCapUsd: number;
  defaultWishBudgetUsd: number;
  perAttemptBudgetUsd: number;
  maxWorkersTotal: number;
  maxTaskAttempts: number;
  /** Strop pro best-of-N (kolik soupeřících kandidátů max na jeden task). */
  maxBestOfN: number;
  maxStepsPerAttempt: number;
  attemptWallClockMin: number;
  pgmqVisibilityTimeoutSec: number;
  refillMaxRoundsPerDay: number;
  refillMaxTasksPerRound: number;
  budgetHoldResetTz: string;
  /** Práh trigram podobnosti pro loop detection (výstupy pokusů). */
  loopSimilarityThreshold: number;
  /** Práh trigram podobnosti pro refill dedup (title+done_condition). */
  dedupSimilarityThreshold: number;
  /** Kolik po sobě jdoucích selhání úkolu → parked. */
  circuitBreakerTaskFailures: number;
  /** Kolik selhání v projektu za den → projekt paused. */
  circuitBreakerProjectFailures: number;
  workerImage: string;
  workerDockerRuntime: string;
  workspacesRoot: string;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  // NaN guard: nečíselná hodnota → fallback (jinak by NaN propagovalo do výpočtů
  // počtu smyček a udělalo nula workerů / rozbité stropy).
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): FarmConfig {
  return {
    farmDailyCapUsd: num("FARM_DAILY_CAP_USD", 15),
    farmDailyMediaCapUsd: num("FARM_DAILY_MEDIA_CAP_USD", 10),
    defaultUserDailyCapUsd: num("DEFAULT_USER_DAILY_CAP_USD", 5),
    defaultProjectDailyCapUsd: num("DEFAULT_PROJECT_DAILY_CAP_USD", 3),
    defaultWishBudgetUsd: num("DEFAULT_WISH_BUDGET_USD", 20),
    perAttemptBudgetUsd: num("PER_ATTEMPT_BUDGET_USD", 0.5),
    maxWorkersTotal: num("MAX_WORKERS_TOTAL", 4),
    maxTaskAttempts: num("MAX_TASK_ATTEMPTS", 3),
    maxBestOfN: num("MAX_BEST_OF_N", 3),
    maxStepsPerAttempt: num("MAX_STEPS_PER_ATTEMPT", 50),
    attemptWallClockMin: num("ATTEMPT_WALL_CLOCK_MIN", 30),
    pgmqVisibilityTimeoutSec: num("PGMQ_VISIBILITY_TIMEOUT_SEC", 2400),
    refillMaxRoundsPerDay: num("REFILL_MAX_ROUNDS_PER_DAY", 6),
    refillMaxTasksPerRound: num("REFILL_MAX_TASKS_PER_ROUND", 5),
    budgetHoldResetTz: str("BUDGET_HOLD_RESET_TZ", "UTC"),
    loopSimilarityThreshold: num("LOOP_SIMILARITY_THRESHOLD", 0.9),
    dedupSimilarityThreshold: num("DEDUP_SIMILARITY_THRESHOLD", 0.85),
    circuitBreakerTaskFailures: num("CIRCUIT_BREAKER_TASK_FAILURES", 3),
    circuitBreakerProjectFailures: num("CIRCUIT_BREAKER_PROJECT_FAILURES", 5),
    workerImage: str("WORKER_IMAGE", "agent-farm-worker:latest"),
    workerDockerRuntime: str("WORKER_DOCKER_RUNTIME", "runc"),
    workspacesRoot: str("WORKSPACES_ROOT", "/var/lib/agent-farm/workspaces"),
  };
}
