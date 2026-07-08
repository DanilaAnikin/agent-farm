"use client";

import { useRealtime } from "@/lib/useRealtime";

/**
 * Neviditelný pomocník: přidá Server Componentu živé obnovení přes Realtime.
 * Umí sledovat víc tabulek najednou.
 */
export function RealtimeRefresh({
  tables,
  filter,
  throttleMs,
}: {
  tables: string[];
  filter?: string;
  throttleMs?: number;
}) {
  return (
    <>
      {tables.map((t) => (
        <RealtimeOne key={t} table={t} filter={filter} throttleMs={throttleMs} />
      ))}
    </>
  );
}

function RealtimeOne({
  table,
  filter,
  throttleMs,
}: {
  table: string;
  filter?: string;
  throttleMs?: number;
}) {
  useRealtime({ table, filter, throttleMs });
  return null;
}
