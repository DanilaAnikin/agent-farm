// Kanonické doménové enumy. Ukládáme je jako text (+ $type v schema.ts) —
// greenfield projekt, chceme flexibilitu bez bolesti s ALTER TYPE.
// POZOR: enum integritu vynucuje POUZE aplikační vrstva (validátory v `packages/core`
// a Zod schémata v `packages/llm`) — v DB NEJSOU žádné CHECK constraints, sloupce jsou
// prostý text. Přímý zápis mimo aplikaci (raw SQL, service-role skript) může vložit
// hodnotu mimo množinu a DB ji nezamítne. Nespoléhej na DB-level guard.

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CONNECTION_KINDS = ["github", "instagram", "telegram", "dokploy"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_STATUSES = ["active", "expired", "revoked", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const PROJECT_KINDS = ["code", "content", "mixed"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const REPO_MODES = ["new", "existing", "none"] as const;
export type RepoMode = (typeof REPO_MODES)[number];

export const PROJECT_STATUSES = ["active", "paused", "budget_hold", "stopped"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// 'autopilot' = přání, které farma zadala sama z vlastního návrhu (suggestion intake).
export const WISH_SOURCES = ["dashboard", "telegram", "voice", "autopilot"] as const;
export type WishSource = (typeof WISH_SOURCES)[number];

export const WISH_STATUSES = [
  "new",
  "specifying",
  "awaiting_spec_approval",
  "active",
  "done",
  "parked",
] as const;
export type WishStatus = (typeof WISH_STATUSES)[number];

export const TASK_KINDS = ["code", "media", "publish", "deploy"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "judging",
  // 'merging' = PR je otevřený a čeká na sloučení. Úkol NENÍ hotový otevřením PR,
  // ale až potvrzeným mergem — dokud se nesloučí, kód v hlavní větvi není.
  "merging",
  "done",
  "failed",
  "parked",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Proč je úkol zaparkovaný (tasks.park_reason). Bez toho nešlo odlišit historickou
 * frontu ('archived') od skutečné poruchy — panel pozornosti hlásil 201 „incidentů",
 * které žádné incidenty nebyly.
 */
export const PARK_REASONS = [
  "archived", // hromadná archivace staré fronty (backlog_task_archived)
  "qa_false_fix", // QA ukázala, že oprava neplatí
  "judge_exhausted", // vyčerpané pokusy u soudce
  "dependency_cascade", // padla závislost, na které úkol stojí
  "empty_diff", // pokus nic nezměnil
  "infra", // infrastruktura (kontejner, git, síť)
  "judging_orphan", // osiřelé posuzování po restartu
  "owner_cancelled", // zrušil majitel z dashboardu
  // Úkol opakovaně vyčerpal per-pokus příděl LiteLLM bez nového commitu — na jeden
  // pokus je moc velký; farma přání přeplánuje na menší kroky (dispatch.ts).
  "attempt_allowance_exhausted",
  // Přání vyčerpalo SVŮJ rozpočet (wishes.budget_usd). Dřív kvůli tomu šel do
  // budget_hold celý PROJEKT, ačkoli scope 'wish' se testuje až jako poslední —
  // tedy všechny širší stropy byly v pořádku a projekt mohl dělat jiná přání.
  // Rozpočet přání se navíc s denním oknem neresetuje, takže se projekt každou
  // půlnoc probudil a do pár minut zas zalehl (ivanweb, 16.–17. 9. 2026).
  "wish_budget_exhausted",
  "unknown", // důvod se nepodařilo dohledat (backfill)
] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export const ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "rejected",
  "failed",
  "aborted",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const JUDGE_VERDICTS = ["approve", "reject", "escalate"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const APPROVAL_TYPES = [
  "spec",
  "publish",
  "deploy_prod",
  "budget",
  "config_change",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// 'autopilot' = rozhodla farma sama (např. specifikace schválená autopilotem).
export const DECIDED_VIA = ["dashboard", "telegram", "autopilot"] as const;
export type DecidedVia = (typeof DECIDED_VIA)[number];

export const COST_SCOPES = ["task", "attempt", "media", "system"] as const;
export type CostScope = (typeof COST_SCOPES)[number];

// 'tester' = QA agent (tester.ts). Dosud se registroval jako 'judge', takže se ve
// velíně zobrazoval jako Soudce a nešlo poznat, kdo vlastně testuje.
export const AGENT_ROLES = ["manager", "worker", "judge", "tester", "media", "publisher"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATUSES = ["idle", "busy", "dead"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MEDIA_KINDS = [
  "video_clip",
  "image",
  "music",
  "voiceover",
  "reel",
  "thumbnail",
  "screenshot",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const QA_STATUSES = ["running", "passed", "failed", "error"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

// Znalostní báze projektu ("mozek projektu") — akumuluje se napříč přáními.
export const MEMORY_KINDS = [
  "architecture", // technický design, struktura, klíčová rozhodnutí
  "decision", // konkrétní rozhodnutí (volba knihovny, kontrakt)
  "convention", // konvence kódu/pojmenování projektu
  "learning", // poučení z reflexe po selhání (co příště jinak)
  "glossary", // doménové pojmy
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = ["architect", "reflection", "success", "manual", "manager"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

// Proaktivní návrhy farmy — UNIVERZÁLNÍ (jakýkoliv cíl projektu, ne jen content).
export const SUGGESTION_KINDS = [
  "improvement",
  "feature",
  "fix",
  "test",
  "content",
  "automation",
  "integration",
  "research",
  "refactor",
  "opportunity",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_STATUSES = ["new", "accepted", "dismissed", "converted"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/**
 * Nastavení autonomie projektu (projects.autonomy jsonb) — KIND-AGNOSTICKÉ.
 * proactive: farma sama generuje návrhy co dál (pro cokoliv).
 * selfRun: ZASTARALÉ, nikdo ho nečte — návrhy se na přání převádějí vždy (intake v orchestrátoru).
 * autoDeliver: nevratné doručení (publish/prod-deploy) se auto-schválí do denního capu.
 */
export interface ProjectAutonomy {
  proactive?: boolean;
  selfRun?: boolean;
  autoDeliver?: boolean;
  deliverDailyCap?: number;
  cadenceHours?: number;
  maxSuggestionsPerRound?: number;
  /** Kolik workerů smí běžet na tomto projektu SOUČASNĚ (swarm paralelizace). */
  maxParallelWorkers?: number;
  /** Best-of-N: kolik soupeřících řešení vygenerovat na úkol (vybere se nejlepší). */
  bestOfN?: number;
}

// Jeden scénář v QA běhu (výsledek ověření kritéria/flow).
export interface QaScenario {
  id: string;
  name: string;
  kind: "web" | "cli" | "api";
  criterionId?: string;
  passed: boolean;
  detail?: string;
  screenshotPath?: string;
  visionScore?: number;
}

export const MEDIA_STATUSES = [
  "generating",
  "generated",
  "needs_review",
  "selected",
  "published",
  "archived",
  "failed",
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const PUBLISH_TARGETS = ["instagram", "manual", "youtube"] as const;
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

export const PUBLISH_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "publishing",
  "published",
  "failed",
] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

// Preferenční profil uživatele (čtou ho všechny jeho projekty).
export interface PreferenceProfile {
  tone?: string;
  style?: string;
  brand?: { colors?: string[]; fonts?: string[]; logoUrl?: string };
  language?: string;
  dos?: string[];
  donts?: string[];
}

// Akceptační kritérium ve specifikaci.
export interface AcceptanceCriterion {
  id: string;
  description: string;
  check?: string; // volitelný strojově ověřitelný příkaz
}
