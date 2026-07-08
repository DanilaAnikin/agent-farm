// Mapování stavů na barevný tón (viz Badge) a české popisky.
import type {
  AgentStatus,
  ApprovalStatus,
  ApprovalType,
  AttemptStatus,
  JudgeVerdict,
  MediaStatus,
  ProjectKind,
  ProjectStatus,
  PublishStatus,
  SuggestionKind,
  TaskKind,
  TaskStatus,
  WishStatus,
} from "@/lib/types";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "violet";

interface Meta {
  label: string;
  tone: Tone;
}

// Meta pro druh proaktivního návrhu farmy (univerzální, kind-agnostické).
interface KindMeta extends Meta {
  emoji: string;
}

export const SUGGESTION_KIND_META: Record<SuggestionKind, KindMeta> = {
  improvement: { label: "Vylepšení", tone: "info", emoji: "✨" },
  feature: { label: "Funkce", tone: "violet", emoji: "🧩" },
  fix: { label: "Oprava", tone: "danger", emoji: "🐞" },
  test: { label: "Testy", tone: "ok", emoji: "🧪" },
  content: { label: "Obsah", tone: "violet", emoji: "🎬" },
  automation: { label: "Automatizace", tone: "info", emoji: "⚙️" },
  integration: { label: "Integrace", tone: "info", emoji: "🔌" },
  research: { label: "Průzkum", tone: "neutral", emoji: "🔬" },
  refactor: { label: "Refaktor", tone: "neutral", emoji: "🧹" },
  opportunity: { label: "Příležitost", tone: "warn", emoji: "🚀" },
};

export const PROJECT_STATUS_META: Record<ProjectStatus, Meta> = {
  active: { label: "Aktivní", tone: "ok" },
  paused: { label: "Pozastaveno", tone: "warn" },
  budget_hold: { label: "Rozpočtový hold", tone: "violet" },
  stopped: { label: "Zastaveno", tone: "neutral" },
};

export const WISH_STATUS_META: Record<WishStatus, Meta> = {
  new: { label: "Nové", tone: "info" },
  specifying: { label: "Specifikuje se", tone: "info" },
  awaiting_spec_approval: { label: "Čeká na schválení spec", tone: "warn" },
  active: { label: "Aktivní", tone: "ok" },
  done: { label: "Hotovo", tone: "neutral" },
  parked: { label: "Zaparkováno", tone: "danger" },
};

export const TASK_STATUS_META: Record<TaskStatus, Meta> = {
  queued: { label: "Ve frontě", tone: "neutral" },
  running: { label: "Běží", tone: "info" },
  judging: { label: "Posuzuje se", tone: "violet" },
  done: { label: "Hotovo", tone: "ok" },
  failed: { label: "Selhalo", tone: "danger" },
  parked: { label: "Zaparkováno", tone: "danger" },
};

export const TASK_KIND_META: Record<TaskKind, Meta> = {
  code: { label: "Kód", tone: "info" },
  media: { label: "Média", tone: "violet" },
  publish: { label: "Publikace", tone: "ok" },
  deploy: { label: "Deploy", tone: "warn" },
};

export const ATTEMPT_STATUS_META: Record<AttemptStatus, Meta> = {
  running: { label: "Běží", tone: "info" },
  succeeded: { label: "Úspěch", tone: "ok" },
  rejected: { label: "Zamítnuto", tone: "warn" },
  failed: { label: "Selhalo", tone: "danger" },
  aborted: { label: "Přerušeno", tone: "neutral" },
};

export const APPROVAL_STATUS_META: Record<ApprovalStatus, Meta> = {
  pending: { label: "Čeká", tone: "warn" },
  approved: { label: "Schváleno", tone: "ok" },
  rejected: { label: "Zamítnuto", tone: "danger" },
  expired: { label: "Vypršelo", tone: "neutral" },
};

export const APPROVAL_TYPE_META: Record<ApprovalType, Meta> = {
  spec: { label: "Specifikace", tone: "info" },
  publish: { label: "Publikace", tone: "violet" },
  deploy_prod: { label: "Produkční deploy", tone: "warn" },
  budget: { label: "Rozpočet", tone: "ok" },
  config_change: { label: "Změna konfigurace", tone: "danger" },
};

export const AGENT_STATUS_META: Record<AgentStatus, Meta> = {
  idle: { label: "Nečinný", tone: "neutral" },
  busy: { label: "Pracuje", tone: "ok" },
  dead: { label: "Mrtvý", tone: "danger" },
};

export const MEDIA_STATUS_META: Record<MediaStatus, Meta> = {
  generating: { label: "Generuje se", tone: "info" },
  generated: { label: "Vygenerováno", tone: "ok" },
  needs_review: { label: "Ke kontrole", tone: "warn" },
  selected: { label: "Vybráno", tone: "violet" },
  published: { label: "Publikováno", tone: "ok" },
  archived: { label: "Archivováno", tone: "neutral" },
  failed: { label: "Selhalo", tone: "danger" },
};

export const PUBLISH_STATUS_META: Record<PublishStatus, Meta> = {
  draft: { label: "Koncept", tone: "neutral" },
  pending_approval: { label: "Čeká na schválení", tone: "warn" },
  approved: { label: "Schváleno", tone: "info" },
  publishing: { label: "Publikuje se", tone: "info" },
  published: { label: "Publikováno", tone: "ok" },
  failed: { label: "Selhalo", tone: "danger" },
};

export const JUDGE_VERDICT_META: Record<JudgeVerdict, Meta> = {
  approve: { label: "Schváleno", tone: "ok" },
  reject: { label: "Zamítnuto", tone: "warn" },
  escalate: { label: "Eskalace", tone: "danger" },
};

export const PROJECT_KIND_META: Record<ProjectKind, Meta> = {
  code: { label: "Kód", tone: "info" },
  content: { label: "Obsah", tone: "violet" },
  mixed: { label: "Smíšený", tone: "ok" },
};

// Navigace v postranním panelu.
export const NAV_ITEMS = [
  { href: "/projects", label: "Projekty", icon: "▣" },
  { href: "/swarm", label: "Roj", icon: "✦" },
  { href: "/approvals", label: "Schvalování", icon: "✓" },
  { href: "/library", label: "Knihovna", icon: "▦" },
  { href: "/costs", label: "Náklady", icon: "$" },
  { href: "/settings/billing", label: "Předplatné", icon: "◈" },
  { href: "/settings", label: "Nastavení", icon: "⚙" },
] as const;

export const ADMIN_NAV_ITEM = { href: "/admin", label: "Administrace", icon: "★" } as const;

// Klíče farm_settings používané dashboardem.
export const FARM_SETTING_KEYS = {
  globalPause: "global_pause",
  farmDailyCapUsd: "farm_daily_cap_usd",
  farmDailyMediaCapUsd: "farm_daily_media_cap_usd",
  maxWorkersTotal: "max_workers_total",
} as const;
