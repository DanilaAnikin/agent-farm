"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useSupabase } from "@/lib/supabase/provider";
import { useRealtime } from "@/lib/useRealtime";
import { farmState, capFromSetting } from "@/lib/farm-state";
import { budgetWidget, fetchLedgerSpend, type LedgerSpend } from "@/lib/budget-widget";
import { RPC, type BudgetSnapshot, type FarmRunState } from "@/lib/rpc";
import { cn } from "@/lib/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Badge } from "@/components/ui/Badge";
import { LiveIndicator } from "@/components/ui/Live";

/**
 * Stav farmy + rozpočet v hlavičce.
 *
 * JEDEN zdroj pravdy: stav se počítá čistou funkcí `farmState()` na serveru
 * i tady po každém obnovení. Dřív hlavička četla jen `global_pause`, takže
 * pauza majitele ani zablokovaný rozpočtový hlídač nebyly vidět a pilulka
 * „Farma běží" svítila nad stojící farmou.
 */

/** Záložní přímé čtení (když RPC `farm_run_state` chybí). Adminovi projde RLS. */
const KLICE_STAVU = [
  "global_pause",
  "owner_pause",
  "pause_source",
  "budget_block",
  "farm_daily_cap_usd",
  "farm_monthly_cap_usd",
  "next_resume_at",
  "offpeak_windows_utc",
] as const;

/** Čísla hlídače (farm_budget_requests) v realtime publikaci nejsou → pravidelné obnovení. */
const OBNOVA_ROZPOCTU_MS = 60_000;

export interface StatusBarProps {
  isAdmin: boolean;
  initialState: FarmRunState;
  /** Stav se nečetl autoritativně (záložní cesta nebo výchozí hodnoty). */
  initialDegraded: boolean;
  initialDegradedReason: string | null;
  /** `farm_budget_snapshot()` — jen admin; jinak null. */
  initialSnapshot: BudgetSnapshot | null;
  /** Útrata z pohybů (člen, nebo admin bez snapshotu). */
  initialLedger: LedgerSpend;
  /** Čas serverového renderu (ISO) — ať se server a klient shodnou na stavu okna. */
  renderedAt: string;
  /** `header` = pruh nahoře, `drawer` = rozepsaný blok v mobilní navigaci. */
  variant?: "header" | "drawer";
}

function useFarmStatus(props: StatusBarProps) {
  const supabase = useSupabase();
  const [state, setState] = useState(props.initialState);
  const [degraded, setDegraded] = useState(props.initialDegraded);
  const [degradedReason, setDegradedReason] = useState(props.initialDegradedReason);
  const [snapshot, setSnapshot] = useState(props.initialSnapshot);
  const [ledger, setLedger] = useState(props.initialLedger);
  const [now, setNow] = useState(() => new Date(props.renderedAt));
  const { isAdmin } = props;

  // router.refresh() přinese nové serverové props — převezmi je.
  useEffect(() => {
    setState(props.initialState);
    setDegraded(props.initialDegraded);
    setDegradedReason(props.initialDegradedReason);
    setSnapshot(props.initialSnapshot);
    setLedger(props.initialLedger);
    setNow(new Date());
  }, [
    props.initialState,
    props.initialDegraded,
    props.initialDegradedReason,
    props.initialSnapshot,
    props.initialLedger,
  ]);

  const refresh = useCallback(async () => {
    // 1) stav farmy — RPC (i pro člena), jinak přímé čtení klíčů pauzy
    const rpc = await supabase.rpc(RPC.farmRunState);
    if (!rpc.error && rpc.data && typeof rpc.data === "object") {
      setState((prev) => ({ ...prev, ...(rpc.data as Partial<FarmRunState>) }));
      setDegraded(false);
      setDegradedReason(null);
    } else {
      const { data, error } = await supabase
        .from("farm_settings")
        .select("key, value")
        .in("key", [...KLICE_STAVU]);
      if (!error && data) {
        const radky = data as Array<{ key: string; value: unknown }>;
        setState((prev) => {
          const dalsi = { ...prev } as unknown as Record<string, unknown>;
          // Klíč, který v tabulce není, je null — ne stará hodnota z minula.
          for (const k of KLICE_STAVU) dalsi[k] = radky.find((r) => r.key === k)?.value ?? null;
          return dalsi as unknown as FarmRunState;
        });
        setDegradedReason("Stav farmy se čte záložní cestou (RPC farm_run_state neodpovídá).");
      } else {
        setDegradedReason("Stav farmy se nepodařilo obnovit — zobrazený stav může být starý.");
      }
      setDegraded(true);
    }

    // 2) rozpočet — admin z hlídače, člen (nebo admin bez hlídače) z pohybů
    let maSnapshot = false;
    if (isAdmin) {
      const snap = await supabase.rpc(RPC.farmBudgetSnapshot);
      if (!snap.error && snap.data && typeof snap.data === "object") {
        const s = snap.data as BudgetSnapshot;
        setSnapshot(s);
        maSnapshot = Boolean(s.admin);
      } else {
        setSnapshot(null);
      }
    }
    if (!maSnapshot) setLedger(await fetchLedgerSpend(supabase));
    setNow(new Date());
  }, [supabase, isAdmin]);

  const realtime = useRealtime({
    // `projects`: přechod do/z budget_hold mění stav farmy („Farma čeká na rozpočet").
    // `tasks`, `wishes`: „čeká na rozpočet" platí jen bez práce v aktivních projektech,
    // takže nový úkol nebo přání musí stav přepočítat hned, ne až po minutovém obnovení.
    // Agenti se mění s úkoly; jejich heartbeat by jen zbytečně spouštěl dotazy.
    tables: ["farm_settings", "cost_ledger", "projects", "tasks", "wishes"],
    onChange: () => void refresh(),
    throttleMs: 2000,
    fallbackPollMs: 30_000,
  });

  // Rezervace hlídače a přechod oken (špička/levné hodiny) realtime neohlásí.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, OBNOVA_ROZPOCTU_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Drawer se mountuje až při otevření — ukaž čerstvá čísla, ne ta z posledního renderu.
  const variant = props.variant ?? "header";
  useEffect(() => {
    if (variant === "drawer") void refresh();
  }, [variant, refresh]);

  const stav = useMemo(
    () =>
      farmState(
        {
          ...state,
          guard_ready: isAdmin && snapshot?.admin ? snapshot.ready : undefined,
        },
        now,
      ),
    [state, snapshot, isAdmin, now],
  );

  const widget = useMemo(
    () =>
      budgetWidget({
        isAdmin,
        snapshot,
        ledger,
        caps: {
          dailyUsd: capFromSetting(state.farm_daily_cap_usd, 0.6),
          monthlyUsd: capFromSetting(state.farm_monthly_cap_usd, 20),
        },
        now,
      }),
    [isAdmin, snapshot, ledger, state.farm_daily_cap_usd, state.farm_monthly_cap_usd, now],
  );

  // Nečetlo se autoritativně a vyšlo „běží" → to nevíme. Pilulka „Farma běží"
  // smí svítit JEN při skutečném code === 'running' z pravdivých dat.
  const nejisty = degraded && stav.code === "running";

  return { stav, widget, nejisty, degradedReason, realtime };
}

export function StatusBar(props: StatusBarProps) {
  const { stav, widget, nejisty, degradedReason, realtime } = useFarmStatus(props);
  const variant = props.variant ?? "header";

  const pilulka = (
    <Badge
      tone={nejisty ? "warn" : stav.tone}
      dot={!(stav.code === "running" && !nejisty)}
      pulse={stav.code === "running" && !nejisty}
      className={cn(variant === "header" && "min-w-0 max-w-[9.5rem] sm:max-w-none")}
    >
      <span className="truncate">{nejisty ? "Stav farmy nejistý" : stav.title}</span>
    </Badge>
  );
  const popisStavu = nejisty ? (degradedReason ?? "Stav farmy se nepodařilo ověřit.") : stav.detail;

  if (variant === "drawer") {
    return (
      <section aria-label="Stav farmy a rozpočet" className="flex flex-col gap-3 border-b border-(--color-border-subtle) p-4">
        <div role="status" aria-live="polite" className="flex flex-col items-start gap-1.5">
          {pilulka}
          <p className="text-xs text-(--color-muted)">{popisStavu}</p>
        </div>

        <dl aria-label={widget.ariaLabel} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-(--color-muted)">Dnes</dt>
          <dd className="tabular-nums">{widget.dayText}</dd>
          <dt className="text-(--color-muted)">Měsíc</dt>
          <dd className="tabular-nums">{widget.monthText}</dd>
          {widget.reservedText ? (
            <>
              <dt className="sr-only">Rezervace</dt>
              <dd className="col-start-2 text-(--color-faint)">{widget.reservedText}</dd>
            </>
          ) : null}
        </dl>
        <ProgressBar ratio={widget.ratio} kind="budget" />
        <p className="t-micro text-(--color-faint)">{widget.title.split("\n")[0]}</p>
        {widget.warning ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-(--color-warn)">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {widget.warning}
          </p>
        ) : null}
        <LiveIndicator connected={realtime.connected} lastRefreshAt={realtime.lastRefreshAt} />
      </section>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-4">
      <div role="status" aria-live="polite" title={`${nejisty ? "Stav farmy nejistý" : stav.title} — ${popisStavu}`} className="flex min-w-0">
        {pilulka}
        <span className="sr-only">{popisStavu}</span>
      </div>

      {/* Mobil: kompaktní útrata (plný rozpis je v navigaci) */}
      <span
        aria-label={widget.ariaLabel}
        title={widget.title}
        className="flex shrink-0 items-baseline gap-1 text-xs tabular-nums sm:hidden"
      >
        <span aria-hidden className="text-[10px] text-(--color-faint)">
          {widget.compactLabel}
        </span>
        <span aria-hidden className={cn(widget.warning && "text-(--color-warn)")}>
          {widget.compactText}
        </span>
      </span>

      {/* Tablet a desktop: jeden rozpočtový widget */}
      <div title={widget.title} className="hidden min-w-[15rem] flex-col gap-1 sm:flex">
        <dl aria-label={widget.ariaLabel} className="flex items-center gap-x-3 text-xs">
          <div className="flex items-baseline gap-x-1.5">
            <dt className="text-(--color-muted)">Dnes</dt>
            <dd className="tabular-nums">{widget.dayText}</dd>
          </div>
          <div className="flex items-baseline gap-x-1.5 border-l border-(--color-border-subtle) pl-3">
            <dt className="text-(--color-muted)">Měsíc</dt>
            <dd className="tabular-nums">{widget.monthText}</dd>
          </div>
          {widget.reservedText ? (
            <div className="hidden items-baseline xl:flex">
              <dt className="sr-only">Rezervace</dt>
              <dd className="text-(--color-faint)">{widget.reservedText}</dd>
            </div>
          ) : null}
          {widget.warning ? (
            <div className="flex items-center text-(--color-warn)">
              <dt className="sr-only">Upozornění</dt>
              <dd className="flex items-center gap-1">
                <AlertTriangle aria-hidden className="size-3.5" />
                <span className="hidden lg:inline">neověřeno</span>
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="flex items-center gap-2">
          <ProgressBar ratio={widget.ratio} kind="budget" className="flex-1" />
          <span className="t-micro hidden shrink-0 text-(--color-faint) lg:inline">{widget.sourceLabel}</span>
        </div>
      </div>

      <LiveIndicator
        connected={realtime.connected}
        lastRefreshAt={realtime.lastRefreshAt}
        className="hidden xl:inline-flex"
      />
    </div>
  );
}
