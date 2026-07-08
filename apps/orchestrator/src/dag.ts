/**
 * DAG DISPATCH (task graph) — event-driven, bez spinu.
 *
 * Architekt vrací tasky s lokálními klíči + depends_on; orchestrátor je uloží,
 * namapuje klíče → uuid a nastaví tasks.dependsOn = [uuid]. Task je DISPATCHOVATELNÝ
 * teprve, když jsou VŠECHNY jeho dependsOn tasky ve stavu 'done'.
 *
 *  - Při zakládání se do q_tasks zařadí JEN kořeny (prázdné dependsOn).
 *  - Když se task stane 'done' (judge), enqueueReadyDependents zařadí ty závislé
 *    tasky, jejichž všechny závislosti jsou už 'done' (žádné cyklení, žádný spin).
 *  - Když task zaparkuje/selže, parkBlockedDependents zaparkuje (tranzitivně)
 *    čekající závislé tasky — nemůžou už nikdy proběhnout.
 *
 * Defenzivní: chyby jen logujeme, smyčku neshazujeme.
 */
import { getDb, tasks, QUEUES, enqueue } from "@farm/db";
import { and, eq, inArray } from "drizzle-orm";
import { taskMachine } from "@farm/core";
import { logEvent } from "./events.js";
import type { TaskMessage } from "./types.js";

interface DagTask {
  id: string;
  projectId: string;
  wishId: string | null;
  kind: TaskMessage["kind"];
  status: string;
  dependsOn: string[];
}

/** Načte všechny tasky přání (pro vyhodnocení grafu). */
async function loadWishTasks(wishId: string): Promise<DagTask[]> {
  const rows = await getDb()
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      wishId: tasks.wishId,
      kind: tasks.kind,
      status: tasks.status,
      dependsOn: tasks.dependsOn,
    })
    .from(tasks)
    .where(eq(tasks.wishId, wishId));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    wishId: r.wishId,
    kind: r.kind,
    status: r.status,
    dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn : [],
  }));
}

/**
 * Jsou splněné všechny závislosti tasku? (Prázdné dependsOn → true.)
 * Používá dispatch jako pojistku před spuštěním (kdyby se sem task dostal dřív).
 */
export async function areDepsMet(dependsOn: string[] | null | undefined): Promise<boolean> {
  const deps = Array.isArray(dependsOn) ? dependsOn.filter((d) => typeof d === "string" && d) : [];
  if (deps.length === 0) return true;
  try {
    const depRows = await getDb()
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, deps));
    const statuses = new Map(depRows.map((r) => [r.id, r.status] as const));
    // Každá závislost musí existovat a být 'done'.
    return deps.every((d) => statuses.get(d) === "done");
  } catch (err) {
    console.error("[dag] areDepsMet selhalo:", err);
    // Bezpečné selhání: raději nespouštět, než spustit předčasně.
    return false;
  }
}

/**
 * Po dokončení tasku zařadí do q_tasks ty jeho závislé tasky, jejichž VŠECHNY
 * závislosti jsou nyní 'done'. Volá judge v 'done' větvi.
 */
export async function enqueueReadyDependents(taskId: string, wishId: string | null): Promise<void> {
  if (!wishId) return;
  try {
    const all = await loadWishTasks(wishId);
    const statusById = new Map(all.map((t) => [t.id, t.status] as const));

    for (const t of all) {
      if (t.status !== "queued") continue; // už běží / hotový / zaparkovaný
      if (!t.dependsOn.includes(taskId)) continue; // nezávisí na právě dokončeném
      const ready = t.dependsOn.every((d) => statusById.get(d) === "done");
      if (!ready) continue;

      const msg: TaskMessage = {
        taskId: t.id,
        projectId: t.projectId,
        wishId: t.wishId,
        kind: t.kind,
      };
      await enqueue(QUEUES.tasks, msg);
      await logEvent({
        projectId: t.projectId,
        wishId,
        taskId: t.id,
        type: "task_unblocked",
        message: `Závislosti splněny — task zařazen do fronty.`,
        data: { dependsOn: t.dependsOn },
      });
    }
  } catch (err) {
    console.error("[dag] enqueueReadyDependents selhalo:", err);
  }
}

/**
 * Když task zaparkuje/selže, tranzitivně zaparkuje čekající ('queued') závislé
 * tasky — bez blokujícího předchůdce už nemůžou proběhnout. Běžící/posuzované
 * tasky nechává být (doběhnou vlastní cestou).
 */
export async function parkBlockedDependents(
  taskId: string,
  wishId: string | null,
  reason: string,
): Promise<void> {
  if (!wishId) return;
  try {
    const all = await loadWishTasks(wishId);

    // BFS jen přes tasky, které skutečně zaparkujeme (status 'queued'). Přes běžící/
    // posuzovaný task NEprocházíme — ten může ještě uspět a odblokovat vlastní podstrom.
    const blocked = new Set<string>([taskId]);
    const queue: string[] = [taskId];
    const toPark: DagTask[] = [];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const t of all) {
        if (blocked.has(t.id)) continue;
        if (!t.dependsOn.includes(cur)) continue;
        if (t.status !== "queued") continue; // běžící/hotový/parked nepropagujeme
        blocked.add(t.id);
        toPark.push(t);
        queue.push(t.id); // jeho čekající závislé taky nemůžou proběhnout
      }
    }

    for (const t of toPark) {
      try {
        taskMachine.assert("queued", "parked");
      } catch {
        continue;
      }
      // Atomicky jen když je stále 'queued' (obrana proti závodu s dispatchem).
      await getDb()
        .update(tasks)
        .set({ status: "parked" })
        .where(and(eq(tasks.id, t.id), eq(tasks.status, "queued")));
      await logEvent({
        projectId: t.projectId,
        wishId,
        taskId: t.id,
        level: "warn",
        type: "task_parked",
        message: `Task zaparkován — blokující závislost neprošla (${reason}).`,
        // cascade=true → projektový circuit breaker tyto (odvozené) parky nepočítá,
        // aby jedno reálné selhání blokující podstrom breaker falešně nespustilo.
        data: { reason: `blocked_by:${taskId}`, cascade: true },
      });
    }
  } catch (err) {
    console.error("[dag] parkBlockedDependents selhalo:", err);
  }
}
