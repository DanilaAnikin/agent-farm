/**
 * TS tvary návratových hodnot databázových RPC (migrace 0013).
 *
 * Proč vůbec RPC: PostgREST vrací nejvýš 1000 řádků, takže `select('*')` nad
 * cost_ledger ukazovalo zlomek skutečné útraty, a `tasks` se kvůli pěti číslům
 * tahaly celé. Agregace patří do SQL — tady je jen jejich typový kontrakt.
 *
 * VŠECHNY funkce se volají přes `supabase.rpc(<jméno>, <args>)` a KAŽDÉ volání
 * musí kontrolovat `error`: spolknutý timeout vypadá v UI jako „nic se neděje",
 * což je nejhorší možná lež o farmě.
 */

// --- farm_run_state() --------------------------------------------------------

/** Syrový stav farmy z `farm_settings` (whitelist klíčů). Chybějící klíč = null. */
export interface FarmRunState {
  owner_pause: unknown;
  global_pause: unknown;
  pause_source: unknown;
  budget_block: unknown;
  farm_daily_cap_usd: unknown;
  farm_daily_media_cap_usd: unknown;
  farm_monthly_cap_usd: unknown;
  /** Nastavení (kolik workerů SMÍ běžet). */
  max_workers_total: unknown;
  /** Skutečnost, kterou hlásí běžící orchestrátor (kolik slotů REÁLNĚ má). */
  runtime_max_workers_total: unknown;
  github_status: GithubStatus | null;
  next_resume_at: unknown;
  offpeak_windows_utc: unknown;
  updated_at: string | null;
  /**
   * Od migrace 0017 (souhrny, ne tajemství): kolik projektů čeká v `budget_hold`,
   * kolik mají čekajících úkolů, od kdy nejstarší čeká a kolik práce mají aktivní
   * projekty. Záložní čtení z `farm_settings` je nemá → stav je pak neuvádí.
   */
  budget_hold_projects?: unknown;
  budget_hold_queued?: unknown;
  budget_hold_since?: unknown;
  active_work?: unknown;
}

/** Stav připojení k GitHubu, jak ho do DB zapisuje orchestrátor. NIKDY neobsahuje token. */
export interface GithubStatus {
  ok: boolean;
  source: "env" | "connection";
  login?: string | null;
  checked_at?: string | null;
  error?: string | null;
}

// --- farm_budget_snapshot() --------------------------------------------------

/**
 * Rozpočet očima hlídače. Tři různá čísla, která se NIKDY nesčítají:
 *   *_settled — zaúčtované pohyby v našem ledgeru (co LiteLLM skutečně změřil),
 *   *_counted — konzervativní součet hlídače (špičkové ceny + rezervace),
 *   deepseek_balance_usd — zůstatek u poskytovatele.
 * Práci blokuje `*_counted`, ne `*_settled` — to musí UI říct nahlas.
 */
export interface BudgetSnapshot {
  admin: boolean;
  day_settled: number | null;
  month_settled: number | null;
  day_counted: number | null;
  month_counted: number | null;
  day_reserved: number | null;
  /** `null` = hlídač nedostupný. NENÍ to totéž co `false` a už vůbec ne jako 0. */
  ready: boolean | null;
  ready_since: string | null;
  deepseek_balance_usd: number | null;
  day_start_utc: string | null;
  month_start_utc: string | null;
}

// --- farm_attention() --------------------------------------------------------

export type AttentionKind =
  | "guard_not_ready"
  | "budget_block"
  | "owner_pause"
  | "pause_overdue"
  | "agent_stalled"
  | "task_stuck"
  | "task_merge_stuck"
  | "deploy_failed";

export interface AttentionItem {
  kind: AttentionKind;
  severity: "warn" | "error";
  title: string;
  detail: string;
  since: string | null;
  project_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
}

export interface FarmAttention {
  admin: boolean;
  items: AttentionItem[];
  count: number;
}

// --- cost_summary(p_since) ---------------------------------------------------

export interface CostSummaryRow {
  day: string;
  project_id: string | null;
  scope: string;
  model: string | null;
  provider: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  rows_count: number;
}

// --- task_rollup(p_since) ----------------------------------------------------

export interface TaskRollupRow {
  project_id: string;
  project_status: string;
  queued: number;
  running: number;
  judging: number;
  merging: number;
  done: number;
  failed: number;
  /** Zaparkované SKUTEČNOU poruchou. */
  parked_live: number;
  /** Zaparkované hromadnou archivací staré fronty — do postupu se nepočítají. */
  parked_archived: number;
  last_activity: string | null;
}

// --- wish_rollup() -----------------------------------------------------------

export interface WishRollupRow {
  project_id: string;
  project_status: string;
  status: string;
  cnt: number;
}

// --- project_last_event() ----------------------------------------------------

export interface ProjectLastEventRow {
  project_id: string;
  event_id: string;
  ts: string;
  type: string;
  level: string;
  message: string;
  task_id: string | null;
  wish_id: string | null;
}

/** Jména RPC na jednom místě, ať se nepřeklepnou v řetězci. */
export const RPC = {
  farmRunState: "farm_run_state",
  farmBudgetSnapshot: "farm_budget_snapshot",
  farmAttention: "farm_attention",
  costSummary: "cost_summary",
  taskRollup: "task_rollup",
  wishRollup: "wish_rollup",
  projectLastEvent: "project_last_event",
} as const;
