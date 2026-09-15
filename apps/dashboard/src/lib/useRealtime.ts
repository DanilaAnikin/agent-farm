"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/lib/supabase/provider";

interface RealtimeOptions {
  /** Jedna tabulka (zpětná kompatibilita). */
  table?: string;
  /** Víc tabulek v JEDNOM kanálu — a tedy jeden záložní polling, ne N. */
  tables?: string[];
  filter?: string;
  // Volitelný throttle (ms) na router.refresh(), default 1000 ms (viz OVERVIEW §5.9).
  throttleMs?: number;
  /**
   * Záložní polling (ms), když kanál není SUBSCRIBED. Výchozí 30 s.
   * 0 = bez pollingu.
   */
  fallbackPollMs?: number;
  onChange?: () => void;
}

export interface RealtimeStatus {
  /** Kanál je opravdu přihlášený (`SUBSCRIBED`). Jen tehdy smí UI psát „živě". */
  connected: boolean;
  /** Kdy se data naposledy obnovila (ms od epochy); `null` před prvním během v prohlížeči. */
  lastRefreshAt: number | null;
}

/** Jak dlouho čekat na SUBSCRIBED, než se přepne na záložní polling. */
const CEKANI_NA_KANAL_MS = 5000;

/**
 * Přihlásí se k Postgres změnám tabulek a při změně (throttlovaně) zavolá
 * router.refresh() — čerstvá data ze Server Componentů.
 *
 * NELŽE O STAVU: dřív se `.subscribe()` volalo bez callbacku, takže UI psalo
 * „živě", i když Kong realtime vůbec nenašel a publikace byla prázdná. Teď se
 * čte status kanálu; když do ~5 s není SUBSCRIBED (nebo spadne), zapne se
 * záložní `router.refresh()` á `fallbackPollMs` — jen při viditelné záložce,
 * ať skrytý tab zbytečně nebombarduje databázi.
 */
export function useRealtime({
  table,
  tables,
  filter,
  throttleMs = 1000,
  fallbackPollMs = 30000,
  onChange,
}: RealtimeOptions): RealtimeStatus {
  const supabase = useSupabase();
  const router = useRouter();
  const lastRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onChange v ref: inline funkce by jinak při každém renderu přehlásila kanál.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [connected, setConnected] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  // Stabilní klíč seznamu tabulek (pole z propu je pokaždé nová reference).
  const seznam = [...new Set([...(tables ?? []), ...(table ? [table] : [])])].sort().join(",");

  useEffect(() => {
    const tabulky = seznam ? seznam.split(",") : [];
    if (tabulky.length === 0) return;

    let zruseno = false;
    let pripojeno = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let cekani: ReturnType<typeof setTimeout> | null = null;

    // Stránka se právě vyrenderovala ze serveru — to je první „obnovení".
    setLastRefreshAt(Date.now());

    const obnov = () => {
      if (zruseno) return;
      lastRun.current = Date.now();
      setLastRefreshAt(lastRun.current);
      if (onChangeRef.current) onChangeRef.current();
      else router.refresh();
    };

    const trigger = () => {
      const now = Date.now();
      const since = now - lastRun.current;
      if (since >= throttleMs) {
        obnov();
      } else if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          obnov();
        }, throttleMs - since);
      }
    };

    const viditelna = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const zastavPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const spustPolling = () => {
      if (poll || fallbackPollMs <= 0 || zruseno) return;
      poll = setInterval(() => {
        if (!pripojeno && viditelna()) obnov();
      }, fallbackPollMs);
    };

    // Po návratu na záložku bez živého kanálu obnov hned, pokud jsou data starší než interval.
    const onVisibility = () => {
      if (pripojeno || fallbackPollMs <= 0 || !viditelna()) return;
      if (Date.now() - lastRun.current >= fallbackPollMs) obnov();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let channel = supabase.channel(
      `rt:${seznam}:${filter ?? "all"}:${Math.random().toString(36).slice(2)}`,
    );
    for (const t of tabulky) {
      channel = channel.on(
        "postgres_changes",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { event: "*", schema: "public", table: t, ...(filter ? { filter } : {}) } as any,
        trigger,
      );
    }

    channel.subscribe((status) => {
      if (zruseno) return;
      if (status === "SUBSCRIBED") {
        pripojeno = true;
        setConnected(true);
        zastavPolling();
      } else {
        // CHANNEL_ERROR, TIMED_OUT, CLOSED — nic živého nechodí, přejdi na polling.
        pripojeno = false;
        setConnected(false);
        spustPolling();
      }
    });

    cekani = setTimeout(() => {
      if (!pripojeno) spustPolling();
    }, CEKANI_NA_KANAL_MS);

    return () => {
      zruseno = true;
      if (cekani) clearTimeout(cekani);
      zastavPolling();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      void supabase.removeChannel(channel);
    };
  }, [supabase, router, seznam, filter, throttleMs, fallbackPollMs]);

  return { connected, lastRefreshAt };
}
