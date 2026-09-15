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

// `${type}|${key}` → čas posledního zápisu (v paměti procesu).
const lastDedupedAt = new Map<string, number>();

/**
 * Zaloguje událost nejvýš jednou za `minIntervalMs` pro danou dvojici (typ, klíč).
 *
 * Na stavy, které se vyhodnocují každé dvě vteřiny v šestnácti smyčkách (hlídač
 * nepřipraven, brána odmítá požadavky…): bez tohohle by tabulka `events` bobtnala
 * tisíci stejných řádků a skutečné události by v časové ose zapadly. Paměť je
 * záměrně jen v procesu — po restartu se stav jednou zapíše znovu, a to je dobře.
 *
 * Vrací `true`, když se událost opravdu zapsala (volající tak může např. vynulovat
 * nasčítaný počet), `false`, když ji dedup potlačil.
 */
export async function logEventDeduped(
  type: string,
  key: string,
  payload: Omit<LogEventInput, "type">,
  minIntervalMs = 3600_000,
): Promise<boolean> {
  const mapKey = `${type}|${key}`;
  const now = Date.now();
  const last = lastDedupedAt.get(mapKey);
  if (last !== undefined && now - last < minIntervalMs) return false;
  // Zapsat značku PŘED await: souběžné smyčky se ptají zároveň a jinak by
  // prošly všechny najednou.
  lastDedupedAt.set(mapKey, now);
  await logEvent({ ...payload, type });
  return true;
}

/** Jen pro testy — zapomene historii deduplikace. */
export function resetEventDedup(): void {
  lastDedupedAt.clear();
}
