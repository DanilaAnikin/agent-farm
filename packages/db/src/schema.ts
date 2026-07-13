import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";
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
  DecidedVia,
  EventLevel,
  JudgeVerdict,
  MediaKind,
  MediaStatus,
  MemoryKind,
  MemorySource,
  PreferenceProfile,
  ProjectAutonomy,
  ProjectKind,
  ProjectStatus,
  SuggestionKind,
  SuggestionStatus,
  PublishStatus,
  PublishTarget,
  QaScenario,
  QaStatus,
  RepoMode,
  TaskKind,
  TaskStatus,
  UserRole,
  WishSource,
  WishStatus,
} from "./enums.js";

// Supabase spravuje `auth.users`; jen na něj odkazujeme.
const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

const now = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// --- profiles: uživatel + globální preferenční profil ------------------------
export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  role: text("role").$type<UserRole>().notNull().default("member"),
  displayName: text("display_name"),
  preferenceProfile: jsonb("preference_profile").$type<PreferenceProfile>().notNull().default({}),
  dailyCapUsd: doublePrecision("daily_cap_usd").notNull().default(5),
  dailyMediaCapUsd: doublePrecision("daily_media_cap_usd").notNull().default(5),
  telegramChatId: text("telegram_chat_id"),
  telegramPairingCode: text("telegram_pairing_code"),
  telegramPairingExpiresAt: timestamp("telegram_pairing_expires_at", { withTimezone: true }),
  // --- billing (Perennial) ---
  stripeCustomerId: text("stripe_customer_id"),
  planKey: text("plan_key").notNull().default("free"),
  subscriptionStatus: text("subscription_status").notNull().default("inactive"),
  subscriptionId: text("subscription_id"),
  subscriptionPeriodEnd: timestamp("subscription_period_end", { withTimezone: true }),
  capsOverride: jsonb("caps_override").$type<Record<string, number> | null>(),
  createdAt: now(),
});

// --- credit_ledger: granty / top-upy / úpravy kreditů ------------------------
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"grant" | "topup" | "adjust" | "refund">().notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    note: text("note"),
    stripeRef: text("stripe_ref"),
    periodStart: timestamp("period_start", { withTimezone: true }),
  },
  (t) => [
    index("credit_ledger_user_ts_idx").on(t.userId, t.ts),
    // Partial-unique na stripe_ref = idempotence Stripe top-upů (addTopup se na to
    // spoléhá). Musí být i ve schématu, jinak by `db:push` index shodil.
    uniqueIndex("credit_ledger_stripe_ref_uq")
      .on(t.stripeRef)
      .where(sql`${t.stripeRef} IS NOT NULL`),
  ],
);

// --- billing_events: idempotence Stripe webhooků -----------------------------
export const billingEvents = pgTable("billing_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- invites: registrace jen na pozvánku -------------------------------------
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  invitedBy: uuid("invited_by").references(() => authUsers.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: now(),
});

// --- connections: per-user šifrované credentials externích služeb ------------
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ConnectionKind>().notNull(),
    // šifrováno CREDENTIALS_ENCRYPTION_KEY; čte jen service-role (orchestrátor/Publisher)
    encryptedCredentials: text("encrypted_credentials"),
    status: text("status").$type<ConnectionStatus>().notNull().default("active"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connections_user_kind_uq").on(t.userId, t.kind)],
);

// --- projects: top-level zapečetěná jednotka práce ---------------------------
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<ProjectKind>().notNull().default("code"),
    repoMode: text("repo_mode").$type<RepoMode>().notNull().default("new"),
    repoUrl: text("repo_url"),
    envRecipe: jsonb("env_recipe").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ProjectStatus>().notNull().default("active"),
    monthlyBudgetUsd: doublePrecision("monthly_budget_usd").notNull().default(200),
    dailyCapUsd: doublePrecision("daily_cap_usd").notNull().default(3),
    managerNote: text("manager_note"),
    trustMode: boolean("trust_mode").notNull().default(false),
    // Nastavení autonomie (proaktivní návrhy, self-run, auto-doručení) — kind-agnostické.
    autonomy: jsonb("autonomy").$type<ProjectAutonomy>().notNull().default({}),
    createdAt: now(),
    // $onUpdate ⇒ každá Drizzle změna řádku (vč. přechodu do budget_hold) bumpne
    // updated_at, takže budget-hold `heldSince` = kdy projekt reálně přešel do holdu.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

// --- wishes: požadavky uživatele do projektu ---------------------------------
export const wishes = pgTable(
  "wishes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").$type<WishSource>().notNull().default("dashboard"),
    status: text("status").$type<WishStatus>().notNull().default("new"),
    budgetUsd: doublePrecision("budget_usd").notNull().default(20),
    spentUsd: doublePrecision("spent_usd").notNull().default(0),
    createdAt: now(),
  },
  (t) => [index("wishes_project_idx").on(t.projectId), index("wishes_status_idx").on(t.status)],
);

// --- specs: verzované specifikace přání --------------------------------------
export const specs = pgTable(
  "specs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wishId: uuid("wish_id")
      .notNull()
      .references(() => wishes.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    contentMd: text("content_md").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<AcceptanceCriterion[]>().notNull().default([]),
    createdByModel: text("created_by_model"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [uniqueIndex("specs_wish_version_uq").on(t.wishId, t.version)],
);

// --- tasks: atomické úkoly s done-condition ----------------------------------
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    wishId: uuid("wish_id").references(() => wishes.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id"),
    kind: text("kind").$type<TaskKind>().notNull().default("code"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    doneCondition: text("done_condition").notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    attemptsCount: integer("attempts_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    // normalizovaný title+done_condition pro mechanický refill dedup
    dedupKey: text("dedup_key").notNull().default(""),
    // DAG: id úkolů, které musí být 'done', než se tento smí dispatchnout
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    // Best-of-N: kolik soupeřících kandidátů na tento úkol (1 = klasika).
    bestOfN: integer("best_of_n").notNull().default(1),
    createdAt: now(),
    // KRITICKÉ: $onUpdate bumpne updated_at na KAŽDÉM přechodu stavu (queued→running→
    // judging→…). Bez toho reconciliation měřila stáří od VZNIKU tasku, takže úkol
    // v 'judging' déle než 15 min od vzniku (běžné) byl vytržen zpod běžícího judge
    // → ping-pong dispatch→judging→reap→dispatch a pálení kreditů. Viz reconciliation.ts.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_wish_idx").on(t.wishId),
    index("tasks_status_idx").on(t.status),
    index("tasks_dedup_idx").on(t.projectId, t.dedupKey),
    // GIN trigram index pro dedup podobnost (refill/guardrails). Musí být i ve
    // schématu, jinak by `db:push` tenhle index shodil a dedup by zpomalil/rozbil.
    index("tasks_dedup_trgm_idx").using("gin", sql`${t.dedupKey} gin_trgm_ops`),
  ],
);

// --- attempts: jeden běh workera na tasku ------------------------------------
export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    model: text("model"),
    opencodeSessionId: text("opencode_session_id"),
    // pgmq message id — idempotence: (task_id, msg_id) je unikátní
    msgId: text("msg_id"),
    worktreeRef: text("worktree_ref"),
    branch: text("branch"),
    status: text("status").$type<AttemptStatus>().notNull().default("running"),
    stepsUsed: integer("steps_used").notNull().default(0),
    wallMs: integer("wall_ms"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    diffStat: jsonb("diff_stat").$type<Record<string, unknown>>(),
    outputSummary: text("output_summary"),
    // Best-of-N kandidát: index kandidáta, skóre od judge, vítěz (ten se merguje).
    candidateIdx: integer("candidate_idx").notNull().default(0),
    score: doublePrecision("score"),
    isWinner: boolean("is_winner").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("attempts_task_idx").on(t.taskId),
    uniqueIndex("attempts_task_msg_uq").on(t.taskId, t.msgId),
    index("attempts_heartbeat_idx").on(t.status, t.heartbeatAt),
  ],
);

// --- reviews: verdikt judge --------------------------------------------------
export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id, { onDelete: "cascade" }),
  judgeModel: text("judge_model"),
  verdict: text("verdict").$type<JudgeVerdict>().notNull(),
  checks: jsonb("checks").$type<Record<string, unknown>>().notNull().default({}),
  reasons: text("reasons"),
  screenshotPath: text("screenshot_path"),
  createdAt: now(),
});

// --- approvals: schvalovací brána --------------------------------------------
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<ApprovalType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    requestedBy: text("requested_by"),
    decidedVia: text("decided_via").$type<DecidedVia>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    index("approvals_user_idx").on(t.userId),
    index("approvals_status_idx").on(t.status),
  ],
);

// --- cost_ledger: každé utracené $ -------------------------------------------
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").$type<CostScope>().notNull(),
    refId: uuid("ref_id"),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCached: integer("tokens_cached").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    isShadow: boolean("is_shadow").notNull().default(false),
  },
  (t) => [
    index("cost_ledger_user_ts_idx").on(t.userId, t.ts),
    index("cost_ledger_project_ts_idx").on(t.projectId, t.ts),
    index("cost_ledger_scope_idx").on(t.scope, t.refId),
  ],
);

// --- media_assets: Content Library -------------------------------------------
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    wishId: uuid("wish_id").references(() => wishes.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    kind: text("kind").$type<MediaKind>().notNull(),
    storagePath: text("storage_path"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    durationS: doublePrecision("duration_s"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<MediaStatus>().notNull().default("generating"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    createdAt: now(),
  },
  (t) => [
    index("media_project_idx").on(t.projectId),
    uniqueIndex("media_idempotency_uq").on(t.idempotencyKey),
  ],
);

// --- publish_requests: publikace ---------------------------------------------
export const publishRequests = pgTable("publish_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaAssetId: uuid("media_asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  target: text("target").$type<PublishTarget>().notNull().default("instagram"),
  caption: text("caption"),
  status: text("status").$type<PublishStatus>().notNull().default("draft"),
  approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
  externalId: text("external_id"),
  permalink: text("permalink"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: now(),
});

// --- agents: registr běžících agentů -----------------------------------------
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").$type<AgentRole>().notNull(),
    model: text("model"),
    containerId: text("container_id"),
    status: text("status").$type<AgentStatus>().notNull().default("idle"),
    currentTaskId: uuid("current_task_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
    createdAt: now(),
  },
  (t) => [index("agents_project_idx").on(t.projectId), index("agents_status_idx").on(t.status)],
);

// --- events: append-only timeline --------------------------------------------
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    wishId: uuid("wish_id"),
    taskId: uuid("task_id"),
    agentId: uuid("agent_id"),
    level: text("level").$type<EventLevel>().notNull().default("info"),
    type: text("type").notNull(),
    message: text("message").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("events_project_ts_idx").on(t.projectId, t.ts),
    index("events_wish_ts_idx").on(t.wishId, t.ts),
  ],
);

// --- qa_runs: běhy Tester agenta (E2E + vizuální verifikace) ------------------
export const qaRuns = pgTable(
  "qa_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    wishId: uuid("wish_id").references(() => wishes.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    status: text("status").$type<QaStatus>().notNull().default("running"),
    passed: boolean("passed"),
    scenarios: jsonb("scenarios").$type<QaScenario[]>().notNull().default([]),
    summary: text("summary"),
    screenshotAssetIds: jsonb("screenshot_asset_ids").$type<string[]>().notNull().default([]),
    appUrl: text("app_url"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: now(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("qa_runs_project_idx").on(t.projectId),
    index("qa_runs_wish_idx").on(t.wishId),
  ],
);

// --- project_memory: znalostní báze projektu ("mozek projektu") ---------------
// Akumuluje architekturu, rozhodnutí, konvence a poučení; každý agent čte
// kompaktní "brief" z těchto řádků → mozek je chytrý a nezapomíná (proti context rot).
export const projectMemory = pgTable(
  "project_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MemoryKind>().notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    source: text("source").$type<MemorySource>().notNull().default("manager"),
    wishId: uuid("wish_id").references(() => wishes.id, { onDelete: "set null" }),
    // Váha/relevance pro sestavení briefu (vyšší = důležitější, drží se déle).
    weight: integer("weight").notNull().default(100),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("project_memory_project_idx").on(t.projectId),
    index("project_memory_kind_idx").on(t.projectId, t.kind),
  ],
);

// --- suggestions: proaktivní návrhy farmy (univerzální, jakýkoliv cíl) --------
export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // NULL = návrh napříč projekty (od farm supervisora).
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SuggestionKind>().notNull().default("improvement"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    rationale: text("rationale"),
    status: text("status").$type<SuggestionStatus>().notNull().default("new"),
    // Když se návrh převede na přání.
    wishId: uuid("wish_id").references(() => wishes.id, { onDelete: "set null" }),
    source: text("source").notNull().default("strategist"),
    createdAt: now(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("suggestions_user_idx").on(t.userId, t.status),
    index("suggestions_project_idx").on(t.projectId),
  ],
);

// --- farm_settings: globální konfigurace (admin) -----------------------------
export const farmSettings = pgTable("farm_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Pomůcka pro RLS SQL: seznam tabulek se sloupcem user_id (přímý scope).
export const USER_SCOPED_TABLES = [
  "profiles",
  "connections",
  "projects",
  "approvals",
  "cost_ledger",
] as const;

// Tabulky scoped přes projekt (join na projects.user_id).
export const PROJECT_SCOPED_TABLES = [
  "wishes",
  "tasks",
  "media_assets",
  "agents",
  "events",
] as const;

export { sql };
