// POUZE PRO SERVER: `createClient` sahá na `next/headers` (cookies), takže
// import z klientské komponenty skončí chybou buildu. Balíček `server-only`
// tu záměrně NENÍ — nezavádíme kvůli tomu novou závislost.
import { createClient } from "@/lib/supabase/server";
import { capFromSetting } from "@/lib/farm-state";
import type { BudgetSnapshot, FarmRunState } from "@/lib/rpc";
import { RPC } from "@/lib/rpc";

/**
 * Serverové čtení stavu farmy a rozpočtu.
 *
 * ZÁSADA: když se pravdu nepodaří přečíst, UI to MUSÍ říct nahlas. Dřív se
 * chyba dotazu spolkla a stránka zobrazila výchozí hodnoty, takže se farma
 * tvářila, že běží a neutratila nic — i když stála a hlídač ji blokoval.
 * Proto obě funkce vracejí `degraded: true`, jakmile se muselo sáhnout po
 * záložní cestě nebo po výchozích hodnotách.
 *
 * Fallback je záměrný: `farm_run_state()` je nová funkce, kterou nasazuje
 * hlavní agent. Dokud migrace neproběhne, dashboard musí fungovat — přečte si
 * `farm_settings` přímo (adminovi to projde přes RLS) a teprve když ani to
 * nevyjde, použije výchozí hodnoty.
 */

/** Klíče, které umí i záložní přímé čtení z `farm_settings`. */
const KLICE_STAVU = [
  "owner_pause",
  "global_pause",
  "pause_source",
  "budget_block",
  "farm_daily_cap_usd",
  "farm_daily_media_cap_usd",
  "farm_monthly_cap_usd",
  "max_workers_total",
  "runtime_max_workers_total",
  "github_status",
  "next_resume_at",
  "offpeak_windows_utc",
] as const;

export interface FarmRunStateResult {
  state: FarmRunState;
  /** Data se nepodařilo přečíst autoritativně — UI to má přiznat. */
  degraded: boolean;
  /** Krátký český popis, co selhalo (pro varovný pruh v UI). */
  degradedReason: string | null;
}

function prazdnyStav(): FarmRunState {
  return {
    owner_pause: null,
    global_pause: null,
    pause_source: null,
    budget_block: null,
    farm_daily_cap_usd: null,
    farm_daily_media_cap_usd: null,
    farm_monthly_cap_usd: null,
    max_workers_total: null,
    runtime_max_workers_total: null,
    github_status: null,
    next_resume_at: null,
    offpeak_windows_utc: null,
    updated_at: null,
  };
}

export async function getFarmRunState(): Promise<FarmRunStateResult> {
  const supabase = await createClient();

  // 1) autoritativní cesta — jedno volání, whitelist klíčů, funguje i pro člena
  const rpc = await supabase.rpc(RPC.farmRunState);
  if (!rpc.error && rpc.data && typeof rpc.data === "object") {
    return {
      state: { ...prazdnyStav(), ...(rpc.data as Partial<FarmRunState>) },
      degraded: false,
      degradedReason: null,
    };
  }

  // 2) záložní cesta — přímé čtení tabulky (adminovi projde přes RLS)
  const primo = await supabase
    .from("farm_settings")
    .select("key, value, updated_at")
    .in("key", [...KLICE_STAVU]);

  if (!primo.error && primo.data) {
    const stav = prazdnyStav();
    let posledni: string | null = null;
    for (const radek of primo.data as Array<{
      key: string;
      value: unknown;
      updated_at: string | null;
    }>) {
      if ((KLICE_STAVU as readonly string[]).includes(radek.key)) {
        (stav as unknown as Record<string, unknown>)[radek.key] = radek.value;
      }
      if (radek.updated_at && (posledni === null || radek.updated_at > posledni)) {
        posledni = radek.updated_at;
      }
    }
    stav.updated_at = posledni;
    return {
      state: stav,
      degraded: true,
      degradedReason:
        "Stav farmy se čte záložní cestou (RPC farm_run_state není nasazené). Čísla mohou být neúplná.",
    };
  }

  // 3) vůbec nic — nelžeme o tom, že je všechno v pořádku
  return {
    state: prazdnyStav(),
    degraded: true,
    degradedReason: "Stav farmy se nepodařilo načíst z databáze.",
  };
}

export interface BudgetSnapshotResult {
  snapshot: BudgetSnapshot;
  degraded: boolean;
  degradedReason: string | null;
}

function prazdnySnapshot(admin: boolean): BudgetSnapshot {
  return {
    admin,
    day_settled: null,
    month_settled: null,
    day_counted: null,
    month_counted: null,
    day_reserved: null,
    ready: null,
    ready_since: null,
    deepseek_balance_usd: null,
    day_start_utc: null,
    month_start_utc: null,
  };
}

/**
 * Rozpočet pro admina. Pro ne-admina vrací `admin: false` a prázdná čísla —
 * hlavička si pak spočítá útratu z `cost_ledger` a popíše ji jako „započteno
 * z pohybů", což je pravda, kterou člen vidět smí.
 */
export async function getBudgetSnapshot(): Promise<BudgetSnapshotResult> {
  const supabase = await createClient();
  const rpc = await supabase.rpc(RPC.farmBudgetSnapshot);

  if (rpc.error || !rpc.data || typeof rpc.data !== "object") {
    return {
      snapshot: prazdnySnapshot(false),
      degraded: true,
      degradedReason:
        "Rozpočtový přehled se nepodařilo načíst (RPC farm_budget_snapshot). Zobrazená čísla nemusí být úplná.",
    };
  }

  const data = rpc.data as Partial<BudgetSnapshot>;
  const snapshot: BudgetSnapshot = { ...prazdnySnapshot(Boolean(data.admin)), ...data };

  // `ready === null` znamená „hlídač je nedostupný", ne „je to v pořádku".
  // Hlavička to má napsat, ne zobrazit nulu, jako by se neutrácelo.
  const degraded = snapshot.admin && snapshot.ready === null;
  return {
    snapshot,
    degraded,
    degradedReason: degraded
      ? "Rozpočtový hlídač neodpovídá — čísla níž jsou jen z našeho ledgeru, ne z brány."
      : null,
  };
}

/**
 * Efektivní stropy se správnými fallbacky. Nikdy nevrátí NaN (viz capFromSetting),
 * protože `NaN / cap` v UI vyrobilo „NaN %" a prázdný ProgressBar.
 */
export function capsFromState(state: FarmRunState): {
  dailyUsd: number;
  dailyMediaUsd: number;
  monthlyUsd: number;
} {
  return {
    dailyUsd: capFromSetting(state.farm_daily_cap_usd, 0.6),
    dailyMediaUsd: capFromSetting(state.farm_daily_media_cap_usd, 0.2),
    monthlyUsd: capFromSetting(state.farm_monthly_cap_usd, 20),
  };
}
