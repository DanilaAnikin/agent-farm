"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/lib/supabase/provider";

interface RealtimeOptions {
  table: string;
  filter?: string;
  // Volitelný throttle (ms) na router.refresh(), default 1000 ms (viz OVERVIEW §5.9).
  throttleMs?: number;
  onChange?: () => void;
}

/**
 * Přihlásí se k Postgres změnám dané tabulky a při změně (throttlovaně)
 * zavolá router.refresh() — čerstvá data ze Server Componentů.
 */
export function useRealtime({ table, filter, throttleMs = 1000, onChange }: RealtimeOptions) {
  const supabase = useSupabase();
  const router = useRouter();
  const lastRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const trigger = () => {
      if (onChange) {
        onChange();
        return;
      }
      const now = Date.now();
      const since = now - lastRun.current;
      if (since >= throttleMs) {
        lastRun.current = now;
        router.refresh();
      } else if (!timer.current) {
        timer.current = setTimeout(() => {
          lastRun.current = Date.now();
          timer.current = null;
          router.refresh();
        }, throttleMs - since);
      }
    };

    const channel = supabase
      .channel(`rt:${table}:${filter ?? "all"}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { event: "*", schema: "public", table, ...(filter ? { filter } : {}) } as any,
        trigger,
      )
      .subscribe();

    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [supabase, router, table, filter, throttleMs, onChange]);
}
