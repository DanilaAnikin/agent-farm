/** Malý helper pro append-only zápis do tabulky events (audit/timeline). */
import { getDb, events } from "@farm/db";
import type { EventLevel } from "@farm/db";

export interface LogEventInput {
  projectId?: string | null;
  wishId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  level?: EventLevel;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** Zapíše jeden event. Chyby zápisu nesmí shodit publikační smyčku — proto try/catch. */
export async function logEvent(e: LogEventInput): Promise<void> {
  try {
    await getDb()
      .insert(events)
      .values({
        projectId: e.projectId ?? null,
        wishId: e.wishId ?? null,
        taskId: e.taskId ?? null,
        agentId: e.agentId ?? null,
        level: e.level ?? "info",
        type: e.type,
        message: e.message ?? "",
        data: e.data ?? null,
      });
  } catch (err) {
    // Poslední záchrana: aspoň do konzole, ať se audit neztratí celý.
    console.error("[publisher] logEvent selhal:", e.type, err);
  }
}
