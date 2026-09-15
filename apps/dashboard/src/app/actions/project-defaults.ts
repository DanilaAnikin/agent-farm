// POUZE PRO SERVER (server akce a server komponenty). Záměrně BEZ "use server":
// exportuje i obyčejné funkce, které se nesmí stát veřejným endpointem.
import { getFarmRunState, capsFromState } from "@/lib/server/farm-state";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Výchozí rozpočty odvozené z farmy.
 *
 * Proč: formuláře měly natvrdo přání 20 US$ (celý měsíční rozpočet farmy),
 * nový projekt 3 US$/den a 200 US$/měsíc — pětkrát až desetkrát nad tím, co
 * farma smí utratit. Strop farmy je autoritativní (hlídač LiteLLM ho vynucuje),
 * takže výchozí hodnoty z něj jen dělíme, nikdy nad něj nejdeme.
 */
export interface FarmBudgetDefaults {
  farmDailyUsd: number;
  farmMonthlyUsd: number;
  /** Denní strop nového projektu = farma / počet aktivních projektů (nový se počítá). */
  projectDailyUsd: number;
  projectMonthlyUsd: number;
  /** Rozpočet nového přání = denní strop farmy. */
  wishBudgetUsd: number;
  /** Stav farmy se nepodařilo přečíst autoritativně (UI to má říct). */
  degraded: boolean;
}

/** Zaokrouhlení DOLŮ na centy — výchozí strop nesmí po zaokrouhlení přetéct farmu. */
function centyDolu(v: number): number {
  return Math.floor(v * 100) / 100;
}

export async function farmBudgetDefaults(supabase: Supabase): Promise<FarmBudgetDefaults> {
  const [{ state, degraded }, aktivni] = await Promise.all([
    getFarmRunState(),
    supabase.from("projects").select("id", { count: "exact", head: true }).eq("status", "active"),
  ]);
  const caps = capsFromState(state);
  // Nový projekt se k aktivním přičítá — jinak by dva nové projekty dostaly každý celou farmu.
  const pocet = Math.max(1, (aktivni.error ? 0 : (aktivni.count ?? 0)) + 1);
  return {
    farmDailyUsd: caps.dailyUsd,
    farmMonthlyUsd: caps.monthlyUsd,
    projectDailyUsd: centyDolu(caps.dailyUsd / pocet),
    projectMonthlyUsd: caps.monthlyUsd,
    wishBudgetUsd: caps.dailyUsd,
    degraded: degraded || Boolean(aktivni.error),
  };
}
