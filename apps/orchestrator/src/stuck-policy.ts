/**
 * POLITIKA UVÁZLÝCH PŘÁNÍ.
 *
 * Přání, jehož specifikace nebo plán opakovaně selhává, dřív skončilo událostí
 * `spec_stuck` / `plan_stuck` s textem „vyžaduje ruční zásah" a viselo navždy.
 * Farma má ale fungovat bez člověka, takže:
 *  1. uvázlé přes 12 h → JEDEN pokus o novou specifikaci (manager ji dělá
 *     s aktuálními fakty z repa a ověřenou identitou projektu);
 *  2. selže i ten → přání se uzavře jako `parked`, zapíše se `wish_auto_archived`
 *     s českým důvodem a poučení do paměti projektu (reflectOnFailure).
 * Zaparkované přání zůstává v korpusu deduplikace, takže farma téma znovu nenavrhne.
 *
 * Volá se z manager smyčky (ta je za `pausable` — politika stojí tokeny) s vlastním
 * in-memory intervalem 30 minut. Tvrdý limit: jedna re-specifikace na přání; další
 * selhání už vždy vede k uzavření, ne k další re-specifikaci (jinak smyčka pálí tokeny).
 */
import { getDb, getSql, projects } from "@farm/db";
import type { WishStatus } from "@farm/db";
import { eq } from "drizzle-orm";
import { wishMachine } from "@farm/core";
import { logEvent } from "./events.js";
import { reflectOnFailure } from "./memory.js";
import { maybeReplanStuckWish } from "./judge.js";

export const STUCK_POLICY_INTERVAL_MS = 30 * 60_000;
/** Jak dlouho musí přání viset, než se zkusí re-specifikace. */
export const STUCK_RESPEC_AFTER_MS = 12 * 3_600_000;
/**
 * Re-specifikace starší než tohle se už nepočítá (přání mezitím prošlo a později
 * uvázlo znovu z jiného důvodu). Vždy ≥ 24 h, takže platí „max 1 re-spec za 24 h".
 */
export const RESPEC_MEMORY_MS = 7 * 24 * 3_600_000;

let lastRunAt = 0;

export type StuckAction = "wait" | "respec" | "archive";

/**
 * Přání, které má úkoly, ale ani jeden spustitelný. Vzniká, když se VŠECHNY jeho
 * úkoly zaparkují mimo parkovací cestu — typicky hromadnou archivací staré fronty
 * (`backlog_task_archived`, 15. 9. 2026). `maybeReplanStuckWish` volají jen
 * parkovací cesty a `maybeCompleteWish` (ta potřebuje dokončený úkol), takže
 * takové přání nikdo nikdy nevezme: zůstane `active` navždy, drží `hasOpenWork`
 * (a tím i příjem návrhů projektu) a dashboard ho počítá jako práci.
 *
 * `planApprovedSpecs` v manager.ts řeší jen přání ÚPLNĚ bez úkolů, proto se tenhle
 * sweep omezuje na `celkem > 0` — jinak by se obě cesty praly o totéž přání.
 */
export function needsReplanSweep(input: {
  runnable: number;
  blocked: number;
  total: number;
  projectActive: boolean;
}): boolean {
  if (!input.projectActive) return false;
  if (input.total === 0) return false; // patří planApprovedSpecs
  if (input.runnable > 0) return false;
  return input.blocked > 0;
}

export function decideStuckAction(input: {
  status: WishStatus;
  stuckAt: Date;
  respecAt: Date | null;
  projectActive: boolean;
  now: Date;
}): StuckAction {
  // Pozastavený projekt manager nezpracovává — nic nepálit, počkat.
  if (!input.projectActive) return "wait";
  const now = input.now.getTime();
  const respec =
    input.respecAt && now - input.respecAt.getTime() < RESPEC_MEMORY_MS ? input.respecAt.getTime() : null;
  if (respec !== null) {
    // Uvázlo znovu PO re-specifikaci → uzavřít. Jinak re-specifikace ještě běží.
    return input.stuckAt.getTime() > respec ? "archive" : "wait";
  }
  // Přání ve stavu 'new' už na novou specifikaci čeká.
  if (input.status === "new") return "wait";
  return now - input.stuckAt.getTime() >= STUCK_RESPEC_AFTER_MS ? "respec" : "wait";
}

interface StuckRow {
  id: string;
  project_id: string;
  title: string;
  status: WishStatus;
  user_id: string;
  project_status: string;
  stuck_at: Date;
  stuck_type: string;
  respec_at: Date | null;
}

/** Zneplatní dosavadní schválení specifikace přání (nová specifikace = nové rozhodnutí). */
async function expireSpecApprovals(wishId: string): Promise<void> {
  await getSql()`
    UPDATE approvals SET status = 'expired'
    WHERE type = 'spec' AND payload->>'wishId' = ${wishId} AND status IN ('pending', 'approved')
  `;
}

function stageLabel(stuckType: string): string {
  return stuckType === "plan_stuck" ? "rozplánovat na úkoly" : "specifikovat";
}

async function respecify(row: StuckRow): Promise<void> {
  if (!wishMachine.can(row.status, "new")) return;
  const updated = await getSql()<{ id: string }[]>`
    UPDATE wishes SET status = 'new' WHERE id = ${row.id} AND status = ${row.status} RETURNING id
  `;
  if (updated.length === 0) return;
  await expireSpecApprovals(row.id);
  await logEvent({
    projectId: row.project_id,
    wishId: row.id,
    level: "warn",
    type: "wish_respec_attempt",
    message:
      `Přání „${row.title}“ déle než 12 hodin nešlo ${stageLabel(row.stuck_type)} — ` +
      `farma zkusí jednu novou specifikaci s aktuálními fakty z repozitáře.`,
    data: { stuckType: row.stuck_type, previousStatus: row.status },
  });
}

async function archive(row: StuckRow): Promise<void> {
  if (!wishMachine.can(row.status, "parked")) return;
  const updated = await getSql()<{ id: string }[]>`
    UPDATE wishes SET status = 'parked' WHERE id = ${row.id} AND status = ${row.status} RETURNING id
  `;
  if (updated.length === 0) return;
  await expireSpecApprovals(row.id);

  const failures = await getSql()<{ message: string }[]>`
    SELECT message FROM events
    WHERE wish_id = ${row.id} AND type IN ('spec_failed', 'plan_failed')
    ORDER BY ts DESC LIMIT 6
  `;
  await logEvent({
    projectId: row.project_id,
    wishId: row.id,
    level: "warn",
    type: "wish_auto_archived",
    message:
      `Farma uzavřela přání „${row.title}“: ani po nové specifikaci ho nešlo ${stageLabel(row.stuck_type)}. ` +
      `Poučení je zapsané v paměti projektu a téma se znovu nenavrhne.`,
    data: { stuckType: row.stuck_type, failures: failures.length },
  });
  // Poučení do project_memory (jedno LLM volání, defenzivní — nikdy nevyhodí).
  await reflectOnFailure({
    projectId: row.project_id,
    userId: row.user_id,
    wishId: row.id,
    taskTitle: `Přání: ${row.title}`,
    doneCondition: "Přání jde specifikovat a rozplánovat na malé ověřitelné úkoly.",
    failures: failures.map((f) => f.message),
  });
}

interface BlockedWishRow {
  wish_id: string;
  project_id: string;
  runnable: number;
  blocked: number;
  total: number;
}

/**
 * Sweep přání, kterým došla spustitelná práce. Sám nic nepřepíná — rozhodnutí i
 * všechny změny stavu dělá `maybeReplanStuckWish` (limit MAX_WISH_REPLANS kol,
 * pak přání odloží, a přeskočí, když v přání něco běží). Projekty mimo `active`
 * se vynechávají: pozastavený ani rozpočtem zastavený projekt se nemá budit.
 */
async function replanBlockedWishes(): Promise<void> {
  const rows = await getSql()<BlockedWishRow[]>`
    SELECT w.id AS wish_id, w.project_id,
           count(t.id) FILTER (WHERE t.status IN ('queued','running','judging','merging'))::int AS runnable,
           count(t.id) FILTER (WHERE t.status IN ('failed','parked'))::int AS blocked,
           count(t.id)::int AS total
    FROM wishes w
    JOIN projects p ON p.id = w.project_id
    LEFT JOIN tasks t ON t.wish_id = w.id
    WHERE w.status = 'active' AND p.status = 'active'
    GROUP BY w.id, w.project_id
    ORDER BY w.created_at
    LIMIT 20
  `;

  for (const row of rows) {
    if (!needsReplanSweep({ ...row, projectActive: true })) continue;
    try {
      const projectRows = await getDb().select().from(projects).where(eq(projects.id, row.project_id)).limit(1);
      const project = projectRows[0];
      if (!project) continue;
      await maybeReplanStuckWish(row.wish_id, project);
    } catch (err) {
      console.error(`[stuck-policy] přeplánování přání ${row.wish_id} selhalo:`, err);
    }
  }
}

/** Jedno kolo politiky (nejvýš jednou za 30 minut, zbytek volání je no-op). */
export async function runStuckPolicyOnce(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastRunAt < STUCK_POLICY_INTERVAL_MS) return;
  lastRunAt = now.getTime();

  await replanBlockedWishes().catch((err) =>
    console.error("[stuck-policy] sweep zablokovaných přání selhal:", err),
  );

  const rows = await getSql()<StuckRow[]>`
    SELECT w.id, w.project_id, w.title, w.status, p.user_id, p.status AS project_status,
           max(e.ts) FILTER (WHERE e.type IN ('spec_stuck', 'plan_stuck')) AS stuck_at,
           (array_agg(e.type ORDER BY e.ts DESC) FILTER (WHERE e.type IN ('spec_stuck', 'plan_stuck')))[1] AS stuck_type,
           max(e.ts) FILTER (WHERE e.type = 'wish_respec_attempt') AS respec_at
    FROM wishes w
    JOIN projects p ON p.id = w.project_id
    JOIN events e ON e.wish_id = w.id AND e.type IN ('spec_stuck', 'plan_stuck', 'wish_respec_attempt')
    WHERE w.status IN ('new', 'specifying', 'awaiting_spec_approval')
    GROUP BY w.id, p.user_id, p.status
    HAVING max(e.ts) FILTER (WHERE e.type IN ('spec_stuck', 'plan_stuck')) IS NOT NULL
    ORDER BY stuck_at ASC
    LIMIT 20
  `;

  for (const row of rows) {
    try {
      const action = decideStuckAction({
        status: row.status,
        stuckAt: new Date(row.stuck_at),
        respecAt: row.respec_at ? new Date(row.respec_at) : null,
        projectActive: row.project_status === "active",
        now,
      });
      if (action === "respec") await respecify(row);
      else if (action === "archive") await archive(row);
    } catch (err) {
      console.error(`[stuck-policy] přání ${row.id} selhalo:`, err);
    }
  }
}
