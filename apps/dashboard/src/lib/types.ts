// Re-export doménových union typů z @farm/db (jen typy — žádný runtime kód).
// Řádkové typy níže odpovídají tomu, co vrací Supabase REST (snake_case sloupce).
import type {
  AcceptanceCriterion,
  AgentRole,
  AgentStatus,
  ApprovalStatus,
  ApprovalType,
  AttemptStatus,
  ConnectionKind,
  ConnectionStatus,
  CostScope,
  EventLevel,
  JudgeVerdict,
  MediaKind,
  MediaStatus,
  PreferenceProfile,
  ProjectKind,
  ProjectStatus,
  PublishStatus,
  PublishTarget,
  RepoMode,
  SuggestionKind,
  SuggestionStatus,
  TaskKind,
  TaskStatus,
  UserRole,
  WishSource,
  WishStatus,
} from "@farm/db";

export type {
  AcceptanceCriterion,
  AgentRole,
  AgentStatus,
  ApprovalStatus,
  ApprovalType,
  AttemptStatus,
  ConnectionKind,
  ConnectionStatus,
  CostScope,
  EventLevel,
  JudgeVerdict,
  MediaKind,
  MediaStatus,
  PreferenceProfile,
  ProjectKind,
  ProjectStatus,
  PublishStatus,
  PublishTarget,
  RepoMode,
  SuggestionKind,
  SuggestionStatus,
  TaskKind,
  TaskStatus,
  UserRole,
  WishSource,
  WishStatus,
};

/**
 * Nastavení autonomie projektu (projects.autonomy jsonb) — KIND-AGNOSTICKÉ.
 * Zrcadlí ProjectAutonomy z @farm/db (drženo lokálně kvůli snake/camel hranici).
 */
export interface ProjectAutonomy {
  proactive?: boolean;
  selfRun?: boolean;
  autoDeliver?: boolean;
  deliverDailyCap?: number;
  cadenceHours?: number;
  maxSuggestionsPerRound?: number;
}

export interface ProfileRow {
  user_id: string;
  role: UserRole;
  display_name: string | null;
  preference_profile: PreferenceProfile;
  daily_cap_usd: number;
  daily_media_cap_usd: number;
  telegram_chat_id: string | null;
  telegram_pairing_code: string | null;
  telegram_pairing_expires_at: string | null;
  // Billing (migrace 0002 + 0009) — auth.ts dělá select('*') do ProfileRow, takže tyhle
  // sloupce v runtime existují; bez nich se musely re-dotazovat s ad-hoc casty.
  stripe_customer_id: string | null;
  plan_key: string;
  subscription_status: string;
  subscription_id: string | null;
  subscription_period_end: string | null;
  caps_override: Record<string, number> | null;
  created_at: string;
}

export interface InviteRow {
  id: string;
  email: string;
  token: string;
  invited_by: string | null;
  used_at: string | null;
  created_at: string;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  kind: ConnectionKind;
  encrypted_credentials: string | null;
  status: ConnectionStatus;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  kind: ProjectKind;
  repo_mode: RepoMode;
  repo_url: string | null;
  env_recipe: Record<string, unknown>;
  status: ProjectStatus;
  monthly_budget_usd: number;
  daily_cap_usd: number;
  manager_note: string | null;
  trust_mode: boolean;
  autonomy: ProjectAutonomy;
  created_at: string;
  updated_at: string;
}

// Řádek proaktivního návrhu farmy (suggestions) tak, jak ho vrací Supabase REST.
export interface SuggestionRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: SuggestionKind;
  title: string;
  description: string;
  rationale: string | null;
  status: SuggestionStatus;
  wish_id: string | null;
  source: string;
  created_at: string;
  decided_at: string | null;
}

export interface WishRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  source: WishSource;
  status: WishStatus;
  budget_usd: number;
  spent_usd: number;
  created_at: string;
}

export interface SpecRow {
  id: string;
  wish_id: string;
  version: number;
  content_md: string;
  acceptance_criteria: AcceptanceCriterion[];
  created_by_model: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  wish_id: string | null;
  parent_task_id: string | null;
  kind: TaskKind;
  title: string;
  description: string;
  done_condition: string;
  status: TaskStatus;
  priority: number;
  attempts_count: number;
  max_attempts: number;
  dedup_key: string;
  // DAG závislosti + best-of-N (migrace 0004/0006) — dřív se depends_on bolt-on castoval.
  depends_on: string[];
  best_of_n: number;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  model: string | null;
  opencode_session_id: string | null;
  msg_id: string | null;
  worktree_ref: string | null;
  branch: string | null;
  status: AttemptStatus;
  steps_used: number;
  wall_ms: number | null;
  cost_usd: number;
  diff_stat: Record<string, unknown> | null;
  output_summary: string | null;
  // Best-of-N (migrace 0006): index kandidáta, skóre od judge, vítěz.
  candidate_idx: number;
  score: number | null;
  is_winner: boolean;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
}

export interface ReviewRow {
  id: string;
  attempt_id: string;
  judge_model: string | null;
  verdict: JudgeVerdict;
  checks: Record<string, unknown>;
  reasons: string | null;
  screenshot_path: string | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  user_id: string;
  project_id: string | null;
  type: ApprovalType;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requested_by: string | null;
  decided_via: "dashboard" | "telegram" | null;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CostLedgerRow {
  id: string;
  ts: string;
  user_id: string | null;
  project_id: string | null;
  scope: CostScope;
  ref_id: string | null;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
  is_shadow: boolean;
}

export interface MediaAssetRow {
  id: string;
  project_id: string;
  wish_id: string | null;
  task_id: string | null;
  kind: MediaKind;
  storage_path: string | null;
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  meta: Record<string, unknown>;
  status: MediaStatus;
  cost_usd: number;
  idempotency_key: string | null;
  created_at: string;
}

export interface PublishRequestRow {
  id: string;
  media_asset_id: string;
  target: PublishTarget;
  caption: string | null;
  status: PublishStatus;
  approval_id: string | null;
  external_id: string | null;
  permalink: string | null;
  published_at: string | null;
  created_at: string;
}

export interface AgentRow {
  id: string;
  project_id: string | null;
  role: AgentRole;
  model: string | null;
  container_id: string | null;
  status: AgentStatus;
  current_task_id: string | null;
  last_heartbeat: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  ts: string;
  project_id: string | null;
  wish_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  level: EventLevel;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
}

export interface FarmSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
}
