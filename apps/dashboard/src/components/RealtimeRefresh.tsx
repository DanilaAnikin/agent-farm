"use client";

import { useRealtime } from "@/lib/useRealtime";
import { LiveIndicator } from "@/components/ui/Live";

/**
 * Pomocník pro Server Component: živé obnovení přes Realtime.
 * Všechny tabulky jdou JEDNÍM kanálem, takže i záložní polling (když realtime
 * nejede) běží jen jednou, ne za každou tabulku zvlášť.
 *
 * Bez `indicator` je neviditelný. S `indicator` vykreslí pravdivý štítek:
 * „živě" jen při přihlášeném kanálu, jinak „obnoveno před X s".
 */
export function RealtimeRefresh({
  tables,
  filter,
  throttleMs,
  fallbackPollMs = 30000,
  indicator = false,
  className,
}: {
  tables: string[];
  filter?: string;
  throttleMs?: number;
  /** Záložní `router.refresh()` (ms), když kanál není SUBSCRIBED. 0 = vypnuto. */
  fallbackPollMs?: number;
  /** Vykreslit štítek stavu (živě / obnoveno před…). */
  indicator?: boolean;
  className?: string;
}) {
  const status = useRealtime({ tables, filter, throttleMs, fallbackPollMs });
  if (!indicator) return null;
  return (
    <LiveIndicator
      connected={status.connected}
      lastRefreshAt={status.lastRefreshAt}
      className={className}
    />
  );
}
