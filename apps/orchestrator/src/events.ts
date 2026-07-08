/**
 * Zápis do append-only tabulky `events` — dashboard i Telegram bot to sledují
 * přes Supabase Realtime. Orchestrátor jen vkládá řádky, nic víc.
 */
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

/** Zaloguje událost do DB. Chyby zápisu jen zalogujeme — event nikdy neshodí smyčku. */
export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    await getDb()
      .insert(events)
      .values({
        projectId: input.projectId ?? null,
        wishId: input.wishId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        level: input.level ?? "info",
        type: input.type,
        message: input.message ?? "",
        data: input.data ?? null,
      });
  } catch (err) {
    console.error("[events] nepodařilo se zapsat event:", input.type, err);
  }
}
