// Sdílené DB dotazy nad @farm/db. Veškerý přístup k DB jde přes tento modul.
import {
  getDb,
  projects,
  wishes,
  tasks,
  attempts,
  agents,
  events,
  costLedger,
  approvals,
  profiles,
  farmSettings,
  suggestions,
  convertSuggestionToWish,
} from "@farm/db";
import { and, count, desc, eq, gt, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { startOfUtcDay, startOfUtcMonth } from "./types.js";
import { ALL_REPORT_TYPES } from "./format.js";

export type ProjectRow = typeof projects.$inferSelect;

// --- projekty ----------------------------------------------------------------

/** Vrátí projekty daného uživatele (nejstarší první, stabilní pořadí). */
export async function getUserProjects(userId: string): Promise<ProjectRow[]> {
  return getDb()
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(projects.createdAt);
}

/**
 * Najde projekt uživatele podle id nebo jména (case-insensitive).
 * Pořadí: přesné id → přesné jméno → unikátní prefix. Vrací undefined,
 * pokud nic / je nejednoznačné.
 */
export async function findUserProject(
  userId: string,
  nameOrId: string,
): Promise<ProjectRow | undefined> {
  const needle = nameOrId.trim().toLowerCase();
  if (needle === "") return undefined;
  const rows = await getUserProjects(userId);
  const byId = rows.find((p) => p.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = rows.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined; // nejednoznačné
  const prefix = rows.filter((p) => p.name.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  return undefined;
}

// --- spend / kredit ----------------------------------------------------------

/** Dnešní útrata (USD) pro projekt z cost_ledger. */
export async function getProjectTodaySpend(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
    .from(costLedger)
    .where(and(eq(costLedger.projectId, projectId), gte(costLedger.ts, startOfUtcDay())));
  return Number(rows[0]?.total ?? 0);
}

/** Dnešní útrata (USD) přes všechny projekty uživatele. */
export async function getUserTodaySpend(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
    .from(costLedger)
    .where(and(eq(costLedger.userId, userId), gte(costLedger.ts, startOfUtcDay())));
  return Number(rows[0]?.total ?? 0);
}

/** Útrata tento měsíc (USD) přes všechny projekty uživatele. */
export async function getUserMonthSpend(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
    .from(costLedger)
    .where(and(eq(costLedger.userId, userId), gte(costLedger.ts, startOfUtcMonth())));
  return Number(rows[0]?.total ?? 0);
}

/** Útrata (USD) za poslední hodinu přes všechny projekty uživatele. */
export async function getUserLastHourSpend(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await getDb()
    .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
    .from(costLedger)
    .where(and(eq(costLedger.userId, userId), gte(costLedger.ts, since)));
  return Number(rows[0]?.total ?? 0);
}

// --- swarm / throughput / fronta ---------------------------------------------

/**
 * Throughput = počet pokusů dokončených (finished_at) za poslední hodinu
 * napříč projekty uživatele. Join attempts → tasks → projects.
 */
export async function getUserThroughputLastHour(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await getDb()
    .select({ n: count() })
    .from(attempts)
    .innerJoin(tasks, eq(tasks.id, attempts.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        eq(projects.userId, userId),
        isNotNull(attempts.finishedAt),
        gte(attempts.finishedAt, since),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** Hloubka fronty = úkoly ve stavu 'queued' napříč projekty uživatele. */
export async function getUserQueueDepth(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.userId, userId), eq(tasks.status, "queued")));
  return Number(rows[0]?.n ?? 0);
}

// --- progres úkolů -----------------------------------------------------------

export interface TaskProgress {
  done: number;
  total: number;
}

function summarizeStatuses(rows: { status: string; n: number }[]): TaskProgress {
  let done = 0;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.status === "done") done += n;
  }
  return { done, total };
}

/** Progres úkolů (done/total) pro projekt. */
export async function getProjectTaskProgress(projectId: string): Promise<TaskProgress> {
  const rows = await getDb()
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .groupBy(tasks.status);
  return summarizeStatuses(rows);
}

/** Progres úkolů (done/total) pro jedno přání. */
export async function getWishTaskProgress(wishId: string): Promise<TaskProgress> {
  const rows = await getDb()
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(eq(tasks.wishId, wishId))
    .groupBy(tasks.status);
  return summarizeStatuses(rows);
}

// --- přání -------------------------------------------------------------------

const ACTIVE_WISH_STATUSES = ["new", "specifying", "awaiting_spec_approval", "active"] as const;

export interface WishRow {
  id: string;
  title: string;
  status: string;
}

/** Aktivní (nedokončená) přání projektu. */
export async function getActiveWishes(projectId: string): Promise<WishRow[]> {
  return getDb()
    .select({ id: wishes.id, title: wishes.title, status: wishes.status })
    .from(wishes)
    .where(and(eq(wishes.projectId, projectId), inArray(wishes.status, [...ACTIVE_WISH_STATUSES])))
    .orderBy(wishes.createdAt);
}

// --- agenti ------------------------------------------------------------------

/** Počet právě běžících (busy) agentů projektu. */
export async function getProjectRunningAgents(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.status, "busy")));
  return Number(rows[0]?.n ?? 0);
}

export interface RunningAgentRow {
  agentId: string;
  role: string;
  model: string | null;
  status: string;
  projectId: string | null;
  projectName: string | null;
  taskTitle: string | null;
  startedAt: Date | null;
  lastHeartbeat: Date;
}

/** Odstraní duplicity vzniklé joinem na attempts (jeden řádek na agenta). */
function dedupeAgents(rows: RunningAgentRow[]): RunningAgentRow[] {
  const seen = new Set<string>();
  const out: RunningAgentRow[] = [];
  for (const r of rows) {
    if (seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    out.push(r);
  }
  return out;
}

/**
 * Živí agenti napříč projekty uživatele — status='busy' NEBO čerstvý heartbeat.
 * Připojí jméno projektu, titulek aktuálního úkolu a start běžícího pokusu
 * (kvůli "jak dlouho běží").
 */
export async function getUserRunningAgents(
  userId: string,
  cutoff: Date,
): Promise<RunningAgentRow[]> {
  const rows = await getDb()
    .select({
      agentId: agents.id,
      role: agents.role,
      model: agents.model,
      status: agents.status,
      projectId: agents.projectId,
      projectName: projects.name,
      taskTitle: tasks.title,
      startedAt: attempts.startedAt,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .leftJoin(tasks, eq(tasks.id, agents.currentTaskId))
    .leftJoin(attempts, and(eq(attempts.taskId, agents.currentTaskId), eq(attempts.status, "running")))
    .where(and(eq(projects.userId, userId), or(eq(agents.status, "busy"), gte(agents.lastHeartbeat, cutoff))))
    .orderBy(desc(agents.lastHeartbeat));
  return dedupeAgents(rows);
}

/** Živí agenti jednoho projektu (stejný tvar jako getUserRunningAgents). */
export async function getProjectRunningAgentRows(
  projectId: string,
  cutoff: Date,
): Promise<RunningAgentRow[]> {
  const rows = await getDb()
    .select({
      agentId: agents.id,
      role: agents.role,
      model: agents.model,
      status: agents.status,
      projectId: agents.projectId,
      projectName: projects.name,
      taskTitle: tasks.title,
      startedAt: attempts.startedAt,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .leftJoin(tasks, eq(tasks.id, agents.currentTaskId))
    .leftJoin(attempts, and(eq(attempts.taskId, agents.currentTaskId), eq(attempts.status, "running")))
    .where(and(eq(agents.projectId, projectId), or(eq(agents.status, "busy"), gte(agents.lastHeartbeat, cutoff))))
    .orderBy(desc(agents.lastHeartbeat));
  return dedupeAgents(rows);
}

// --- události ----------------------------------------------------------------

export interface EventRow {
  ts: Date;
  level: string;
  type: string;
  message: string;
}

/** Posledních N událostí projektu (nejnovější první). */
export async function getRecentProjectEvents(
  projectId: string,
  limit: number,
): Promise<EventRow[]> {
  return getDb()
    .select({ ts: events.ts, level: events.level, type: events.type, message: events.message })
    .from(events)
    .where(eq(events.projectId, projectId))
    .orderBy(desc(events.ts))
    .limit(limit);
}

export interface UserEventRow extends EventRow {
  projectName: string | null;
}

/** Události napříč projekty uživatele od daného času (pro /digest). */
export async function getRecentUserEvents(
  userId: string,
  since: Date,
  limit: number,
): Promise<UserEventRow[]> {
  return getDb()
    .select({
      ts: events.ts,
      level: events.level,
      type: events.type,
      message: events.message,
      projectName: projects.name,
    })
    .from(events)
    .innerJoin(projects, eq(projects.id, events.projectId))
    .where(and(eq(projects.userId, userId), gte(events.ts, since)))
    .orderBy(desc(events.ts))
    .limit(limit);
}

export interface ReportEventRow {
  ts: Date;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  projectName: string | null;
}

/**
 * Reportovatelné události uživatele novější než kurzor (řazeno vzestupně).
 * Filtruje na kontraktní typy (POSITIVE + ATTENTION + 'report').
 */
export async function getReportEvents(
  userId: string,
  after: Date,
  limit: number,
): Promise<ReportEventRow[]> {
  return getDb()
    .select({
      ts: events.ts,
      type: events.type,
      message: events.message,
      data: events.data,
      projectName: projects.name,
    })
    .from(events)
    .innerJoin(projects, eq(projects.id, events.projectId))
    .where(
      and(
        eq(projects.userId, userId),
        gt(events.ts, after),
        inArray(events.type, [...ALL_REPORT_TYPES]),
      ),
    )
    .orderBy(events.ts)
    .limit(limit);
}

// --- suggestions (proaktivní návrhy farmy „co dál") --------------------------

export interface SuggestionRow {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: string;
  title: string;
  description: string;
  rationale: string | null;
}

/**
 * Nové (nerozhodnuté) návrhy uživatele — projektové i napříč projekty
 * (projectId == null). Nejnovější první.
 */
export async function getNewSuggestions(userId: string, limit = 20): Promise<SuggestionRow[]> {
  return getDb()
    .select({
      id: suggestions.id,
      projectId: suggestions.projectId,
      projectName: projects.name,
      kind: suggestions.kind,
      title: suggestions.title,
      description: suggestions.description,
      rationale: suggestions.rationale,
    })
    .from(suggestions)
    .leftJoin(projects, eq(projects.id, suggestions.projectId))
    .where(and(eq(suggestions.userId, userId), eq(suggestions.status, "new")))
    .orderBy(desc(suggestions.createdAt))
    .limit(limit);
}

export interface SuggestionDecisionRow {
  id: string;
  projectName: string | null;
  title: string;
  status: string;
  decidedReason: string | null;
  decidedAt: Date | null;
}

/**
 * Co farma o návrzích uživatele sama rozhodla (zadala / zahodila) od `since`.
 * Nejnovější první.
 */
export async function getRecentSuggestionDecisions(
  userId: string,
  since: Date,
  limit = 15,
): Promise<SuggestionDecisionRow[]> {
  return getDb()
    .select({
      id: suggestions.id,
      projectName: projects.name,
      title: suggestions.title,
      status: suggestions.status,
      decidedReason: suggestions.decidedReason,
      decidedAt: suggestions.decidedAt,
    })
    .from(suggestions)
    .leftJoin(projects, eq(projects.id, suggestions.projectId))
    .where(
      and(
        eq(suggestions.userId, userId),
        inArray(suggestions.status, ["converted", "dismissed"]),
        gte(suggestions.decidedAt, since),
      ),
    )
    .orderBy(desc(suggestions.decidedAt))
    .limit(limit);
}

export interface DecideSuggestionResult {
  ok: boolean;
  text: string;
}

/**
 * „Zadat hned": farma by návrh zadala sama, jakmile na něj přijde řada; tohle ho
 * jen předběhne. Převod jde přes JEDINOU sdílenou implementaci v @farm/db (stejně
 * jako orchestrátor), takže platí stejná pravidla — do pozastaveného projektu ani
 * napříč projekty se práce nezakládá.
 */
export async function acceptSuggestionForUser(
  userId: string,
  id: string,
): Promise<DecideSuggestionResult> {
  const res = await convertSuggestionToWish(getDb(), id, { source: "telegram", userId });
  if (res.ok) {
    return {
      ok: true,
      text: `▶️ Návrh „${res.title}“ zadán hned — manažer z něj připraví specifikaci.`,
    };
  }
  switch (res.reason) {
    case "not_found":
      return { ok: false, text: "Návrh už není k dispozici." };
    case "already_decided":
      return { ok: false, text: "O tomto návrhu už farma rozhodla." };
    case "no_project":
      return {
        ok: false,
        text: "Návrh nepatří k jednomu projektu — práci napříč projekty farma nezakládá a sama ho zahodí.",
      };
    case "project_paused":
      return { ok: false, text: "Projekt je pozastavený — do pozastaveného projektu farma práci nezakládá." };
  }
}

/** Zahození návrhu vlastníkem: status 'dismissed' s důvodem 'owner_dismissed'. */
export async function dismissSuggestionForUser(
  userId: string,
  id: string,
): Promise<DecideSuggestionResult> {
  const updated = await getDb()
    .update(suggestions)
    .set({ status: "dismissed", decidedAt: new Date(), decidedReason: "owner_dismissed" })
    .where(and(eq(suggestions.id, id), eq(suggestions.userId, userId), eq(suggestions.status, "new")))
    .returning({ title: suggestions.title, projectId: suggestions.projectId });
  const s = updated[0];
  if (!s) return { ok: false, text: "O tomto návrhu už farma rozhodla, nebo už není k dispozici." };
  await insertEvent({
    projectId: s.projectId,
    type: "suggestion_dismissed",
    level: "info",
    message: `Návrh „${s.title}“ zahodil vlastník přes Telegram.`,
    data: { suggestionId: id, title: s.title, reason: "owner_dismissed", via: "telegram" },
  });
  return { ok: true, text: `✖️ Návrh „${s.title}“ zahozen.` };
}

// --- approvals ---------------------------------------------------------------

/** Počet čekajících schválení uživatele. */
export async function getPendingApprovalsCount(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.status, "pending")));
  return Number(rows[0]?.n ?? 0);
}

// --- spárované profily (pro reporter) ----------------------------------------

export interface PairedProfile {
  userId: string;
  chatId: string;
}

/** Uživatelé se spárovaným Telegramem (mají telegram_chat_id). */
export async function getPairedProfiles(): Promise<PairedProfile[]> {
  const rows = await getDb()
    .select({ userId: profiles.userId, chatId: profiles.telegramChatId })
    .from(profiles)
    .where(isNotNull(profiles.telegramChatId));
  const out: PairedProfile[] = [];
  for (const r of rows) {
    if (r.chatId) out.push({ userId: r.userId, chatId: r.chatId });
  }
  return out;
}

// --- farm_settings (durabilní kurzory reporteru) -----------------------------

/** Přečte hodnotu z farm_settings (jsonb) nebo undefined. */
export async function getSetting(key: string): Promise<unknown> {
  const rows = await getDb()
    .select({ value: farmSettings.value })
    .from(farmSettings)
    .where(eq(farmSettings.key, key))
    .limit(1);
  return rows[0]?.value;
}

/** Zapíše hodnotu do farm_settings (upsert). */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(farmSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: farmSettings.key, set: { value, updatedAt: new Date() } });
}

// --- události (append) -------------------------------------------------------

/** Zapíše řádek do append-only timeline `events`. */
export async function insertEvent(input: {
  projectId?: string | null;
  wishId?: string | null;
  taskId?: string | null;
  level?: "debug" | "info" | "warn" | "error";
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await getDb()
    .insert(events)
    .values({
      projectId: input.projectId ?? null,
      wishId: input.wishId ?? null,
      taskId: input.taskId ?? null,
      level: input.level ?? "info",
      type: input.type,
      message: input.message ?? "",
      data: input.data,
    });
}
