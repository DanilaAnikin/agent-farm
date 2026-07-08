/**
 * Registr běžících agentů (tabulka `agents`) — živý přehled flotily pro
 * Telegram (/agents) i dashboard. Orchestrátor je jediný, kdo sem zapisuje.
 *
 * Model: jeden řádek na aktivního agenta.
 *  - worker: role='worker', currentTaskId=task, status='busy' po dobu pokusu;
 *  - judge:  role='judge',  currentTaskId=task, status='busy' po dobu posouzení;
 *  - manager: role='manager', globální (project_id NULL), heartbeat každý tick.
 * Řádky se udržují čerstvé přes lastHeartbeat; reconciliation je označí 'dead'
 * a uklidí, když heartbeat zestárne.
 *
 * VŠECHNY funkce jsou defenzivní (nikdy nevyhodí) — registr je jen observabilita
 * a nikdy nesmí shodit dispatch/judge/manager smyčku.
 */
import { getDb, agents } from "@farm/db";
import type { AgentRole } from "@farm/db";
import { and, eq, isNull, isNotNull, lt } from "drizzle-orm";

export interface RegisterAgentInput {
  role: AgentRole;
  projectId?: string | null;
  model?: string | null;
  containerId?: string | null;
  currentTaskId?: string | null;
}

/**
 * Upsertne řádek agenta (podle logického klíče) a nastaví ho na 'busy'
 * s čerstvým heartbeatem. Vrací id řádku, nebo null když zápis selhal.
 *
 * Logický klíč: (role, currentTaskId) když je task; jinak (role, projectId).
 * Díky tomu redelivery/opakovaný běh nevytvoří duplikát řádku.
 */
export async function registerAgent(input: RegisterAgentInput): Promise<string | null> {
  const { role } = input;
  const projectId = input.projectId ?? null;
  const model = input.model ?? null;
  const containerId = input.containerId ?? null;
  const currentTaskId = input.currentTaskId ?? null;
  const now = new Date();

  try {
    // Najdi existující řádek podle logického klíče.
    const conds = [eq(agents.role, role)];
    if (currentTaskId) {
      conds.push(eq(agents.currentTaskId, currentTaskId));
    } else if (projectId) {
      conds.push(eq(agents.projectId, projectId), isNull(agents.currentTaskId));
    } else {
      conds.push(isNull(agents.projectId), isNull(agents.currentTaskId));
    }
    const existing = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(...conds))
      .limit(1);

    const found = existing[0];
    if (found) {
      // Aktualizuj jen smysluplně předané hodnoty (nepřepiš model/container na null).
      await getDb()
        .update(agents)
        .set({
          status: "busy",
          projectId,
          lastHeartbeat: now,
          ...(model !== null ? { model } : {}),
          ...(containerId !== null ? { containerId } : {}),
        })
        .where(eq(agents.id, found.id));
      return found.id;
    }

    const ins = await getDb()
      .insert(agents)
      .values({ role, projectId, model, containerId, currentTaskId, status: "busy", lastHeartbeat: now })
      .returning({ id: agents.id });
    return ins[0]?.id ?? null;
  } catch (err) {
    console.error("[agents-registry] registerAgent selhalo:", err);
    return null;
  }
}

/** Osvěží heartbeat agenta (a volitelně doplní containerId). */
export async function heartbeatAgent(
  agentId: string | null,
  extra?: { containerId?: string },
): Promise<void> {
  if (!agentId) return;
  try {
    await getDb()
      .update(agents)
      .set({
        status: "busy",
        lastHeartbeat: new Date(),
        ...(extra?.containerId ? { containerId: extra.containerId } : {}),
      })
      .where(eq(agents.id, agentId));
  } catch (err) {
    console.error("[agents-registry] heartbeatAgent selhalo:", err);
  }
}

/**
 * Uvolní agenta po dokončení práce.
 *  - keepIdle=false (default): řádek smaže (efemérní worker/judge).
 *  - keepIdle=true: nastaví 'idle' a čerstvý heartbeat (dlouhožijící manager).
 */
export async function releaseAgent(
  agentId: string | null,
  opts?: { keepIdle?: boolean },
): Promise<void> {
  if (!agentId) return;
  try {
    if (opts?.keepIdle) {
      await getDb()
        .update(agents)
        .set({ status: "idle", currentTaskId: null, lastHeartbeat: new Date() })
        .where(eq(agents.id, agentId));
    } else {
      await getDb().delete(agents).where(eq(agents.id, agentId));
    }
  } catch (err) {
    console.error("[agents-registry] releaseAgent selhalo:", err);
  }
}

/**
 * Úklid mrtvých agentů (volá reconciliation):
 *  - řádky se zastaralým heartbeatem (> staleMs) označí 'dead' (ať je vidět);
 *  - hodně staré 'dead' řádky (> 3× staleMs) smaže, aby registr nebobtnal.
 */
/**
 * Container id workerů, kteří MAJÍ žít (agent status='busy' s containerId) — pro
 * přesné určení osiřelých kontejnerů v reconciliation. ZÁMĚRNĚ NEfiltrujeme na
 * čerstvý heartbeat: pomalá setup fáze (git clone/worktree) může mít starší
 * heartbeat, ale worker žije → nesmíme mu zabít kontejner. Skutečně mrtvé agenty
 * označí 'dead' reapDeadAgents (běží ve stejném cyklu) a kontejner se pak uklidí
 * v příštím cyklu. Defenzivní: při chybě vrátí prázdno.
 */
export async function liveContainerIds(): Promise<Set<string>> {
  try {
    const rows = await getDb()
      .select({ containerId: agents.containerId })
      .from(agents)
      .where(and(eq(agents.status, "busy"), isNotNull(agents.containerId)));
    return new Set(rows.map((r) => r.containerId).filter((c): c is string => Boolean(c)));
  } catch (err) {
    console.error("[agents-registry] liveContainerIds selhalo:", err);
    return new Set();
  }
}

export async function reapDeadAgents(staleMs: number): Promise<void> {
  try {
    const now = Date.now();
    const staleBefore = new Date(now - staleMs);
    const deleteBefore = new Date(now - 3 * staleMs);

    await getDb()
      .update(agents)
      .set({ status: "dead" })
      .where(and(lt(agents.lastHeartbeat, staleBefore), eq(agents.status, "busy")));
    await getDb()
      .update(agents)
      .set({ status: "dead" })
      .where(and(lt(agents.lastHeartbeat, staleBefore), eq(agents.status, "idle")));

    await getDb().delete(agents).where(lt(agents.lastHeartbeat, deleteBefore));
  } catch (err) {
    console.error("[agents-registry] reapDeadAgents selhalo:", err);
  }
}
