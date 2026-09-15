// POUZE PRO SERVER: sahá na cookies přes createClient.
import { createClient } from "@/lib/supabase/server";
import { capsFromState, getBudgetSnapshot, getFarmRunState } from "@/lib/server/farm-state";
import { farmState, type FarmState } from "@/lib/farm-state";
import { farmSpend, spendSourceLabel, type BudgetSource } from "@/lib/budget-widget";
import { RPC, type CostSummaryRow, type FarmRunState, type TaskRollupRow, type WishRollupRow } from "@/lib/rpc";
import { isOffpeakUtc, nextOffpeakStart, parseOffpeakWindows, startOfUtcDayIso, startOfUtcMonthIso, type UtcWindow } from "@/lib/time";
import { monthLabelCs } from "./FarmStatusBand";

/**
 * Společné načtení stavu farmy pro /swarm a /projects.
 *
 * Proč jedno místo: obě stránky dřív stahovaly celé tabulky (`tasks` bez limitu,
 * `cost_ledger` přes limit 1000 řádků) a počítaly v JS. Agregace jsou teď v RPC
 * (task_rollup, wish_rollup, cost_summary) a každá chyba se vrací jako česká
 * hláška — spolknutý timeout nesmí vypadat jako „nic se neděje".
 */
export interface FarmOverview {
  run: FarmRunState;
  state: FarmState;
  /** Hlídač LiteLLM: null = nedostupný nebo ne-admin (neznamená „v pořádku"). */
  guardReady: boolean | null;
  degradedReason: string | null;
  caps: { dailyUsd: number; monthlyUsd: number };
  windows: UtcWindow[];
  sinceIso: string | null;
  nextOffpeakIso: string | null;
  monthLabel: string;
  rollup: TaskRollupRow[];
  rollupError: string | null;
  wishRollup: WishRollupRow[];
  wishRollupError: string | null;
  /**
   * Útrata farmy dnes a za měsíc — STEJNÉ číslo jako v hlavičce: u admina
   * započtené hlídačem (o blokaci rozhoduje ono), jinak z pohybů.
   */
  todaySpend: number | null;
  monthSpend: number | null;
  spendSource: BudgetSource;
  spendSourceLabel: string;
  /** Změřeno z pohybů po projektech (karty projektů, denní stropy projektů). */
  todaySpendByProject: Record<string, number>;
  spendError: string | null;
}

export async function loadFarmOverview(now: Date = new Date()): Promise<FarmOverview> {
  const supabase = await createClient();
  const zacatekMesice = startOfUtcMonthIso(now);
  const dnesKlic = startOfUtcDayIso(now).slice(0, 10);

  const [run, budget, rollupRes, wishRes, costRes] = await Promise.all([
    getFarmRunState(),
    getBudgetSnapshot(),
    supabase.rpc(RPC.taskRollup),
    supabase.rpc(RPC.wishRollup),
    supabase.rpc(RPC.costSummary, { p_since: zacatekMesice }),
  ]);

  const guardReady = budget.snapshot.admin ? budget.snapshot.ready : null;
  const state = farmState({ ...run.state, guard_ready: guardReady }, now);
  const windows = parseOffpeakWindows(run.state.offpeak_windows_utc);

  // Pohyby: jeden agregovaný dotaz za měsíc, dnešek z něj (klíč dne je UTC, jako strop).
  let ledgerDen: number | null = null;
  let ledgerMesic: number | null = null;
  const todaySpendByProject: Record<string, number> = {};
  if (!costRes.error) {
    ledgerDen = 0;
    ledgerMesic = 0;
    for (const r of (costRes.data as CostSummaryRow[] | null) ?? []) {
      const castka = Number(r.cost_usd) || 0;
      ledgerMesic += castka;
      if (String(r.day).slice(0, 10) === dnesKlic) {
        ledgerDen += castka;
        if (r.project_id) todaySpendByProject[r.project_id] = (todaySpendByProject[r.project_id] ?? 0) + castka;
      }
    }
  }
  // Pás „Stav farmy" dřív ukazoval „Září 2,40 / 20,00 US$" z pohybů, zatímco hlavička
  // nad ním „Měsíc 5,89 / 20,00 US$" od hlídače. Obojí teď jde přes farmSpend().
  const spend = farmSpend({
    isAdmin: budget.snapshot.admin,
    snapshot: budget.snapshot.admin ? budget.snapshot : null,
    ledger: { day: ledgerDen, month: ledgerMesic },
  });

  // Od kdy stav platí: u zamčeného hlídače jeho čas, u pauzy poslední zápis nastavení.
  const sinceIso =
    guardReady === false
      ? (budget.snapshot.ready_since ?? run.state.updated_at)
      : state.paused
        ? run.state.updated_at
        : null;
  const pristi = isOffpeakUtc(now, windows) ? null : nextOffpeakStart(now, windows);

  const degraded = [run.degradedReason, budget.degraded ? budget.degradedReason : null].filter(Boolean);

  return {
    run: run.state,
    state,
    guardReady,
    degradedReason: degraded.length > 0 ? degraded.join(" ") : null,
    caps: (() => {
      const c = capsFromState(run.state);
      return { dailyUsd: c.dailyUsd, monthlyUsd: c.monthlyUsd };
    })(),
    windows,
    sinceIso,
    nextOffpeakIso: pristi ? pristi.toISOString() : null,
    monthLabel: monthLabelCs(now),
    rollup: (rollupRes.data as TaskRollupRow[] | null) ?? [],
    rollupError: rollupRes.error ? `Frontu úkolů se nepodařilo načíst (${rollupRes.error.message}).` : null,
    wishRollup: (wishRes.data as WishRollupRow[] | null) ?? [],
    wishRollupError: wishRes.error ? `Přehled přání se nepodařilo načíst (${wishRes.error.message}).` : null,
    todaySpend: spend.day,
    monthSpend: spend.month,
    spendSource: spend.source,
    spendSourceLabel: spendSourceLabel(spend.source),
    todaySpendByProject,
    spendError: costRes.error ? `Útratu po projektech se nepodařilo načíst (${costRes.error.message}).` : null,
  };
}
