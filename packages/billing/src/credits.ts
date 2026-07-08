/**
 * Kredity — výpočet zůstatku a enforcement. Model (dvě nezávislé kapsy):
 *  - MĚSÍČNÍ příděl plánu (plan.monthlyCreditUsd) se resetuje 1. dne měsíce (UTC),
 *    použij-nebo-ztrať;
 *  - PERSISTENTNÍ kapsa = zaplacené top-upy + admin úpravy (NIKDY neexpirují) mínus
 *    spotřeba, která v jednotlivých měsících přesáhla měsíční příděl (overflow).
 * Zůstatek = zbytek měsíčního přídělu + zbytek persistentní kapsy.
 * (Dřív se top-upy scopovaly jen na měsíc nákupu → zaplacené kredity mizely na
 *  hranici měsíce — to byla chyba.)
 */
import { getSql, getDb, profiles, creditLedger } from "@farm/db";
import { eq } from "drizzle-orm";
import { getPlan } from "./plans.js";

export interface CreditBalance {
  planKey: string;
  allowanceUsd: number; // příděl plánu + top-upy tohoto měsíce
  spentUsd: number; // spotřeba tohoto měsíce
  remainingUsd: number;
  periodStart: string; // ISO
  ok: boolean; // remaining > 0
}

/** Začátek účtovacího období = 1. den měsíce v UTC. */
export function currentPeriodStartIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
}

export async function creditBalance(userId: string): Promise<CreditBalance> {
  const profRows = await getDb()
    .select({ planKey: profiles.planKey })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const planKey = profRows[0]?.planKey ?? "free";
  const plan = getPlan(planKey);

  const sql = getSql();
  const periodStart = currentPeriodStartIso();
  const monthlyAllowance = plan.monthlyCreditUsd;

  // Spotřeba TOHOTO měsíce (cost_ledger, včetně shadow — počítá se do kvóty).
  const spendRows = await sql<{ sum: number | null }[]>`
    SELECT COALESCE(sum(cost_usd), 0) AS sum
    FROM cost_ledger
    WHERE user_id = ${userId}
      AND ts >= ${periodStart}::timestamptz
  `;
  const spentUsd = Number(spendRows[0]?.sum ?? 0);

  // Persistentní top-up zůstatek: VŠECHNY top-upy + admin úpravy celoživotně
  // (NIKDY neexpirují). Žádný přepočet overflow aktuálním přídělem — to při
  // DOWNGRADE plánu retroaktivně ničilo zaplacené kredity (a dělalo „historický
  // dluh"). Downgrade-safe a konzistentní s metrem (remaining = allowance − spent).
  // POZN (známé omezení v1): top-up navyšuje strop v každém měsíci, dokud není
  // spotřebován daný měsíc; přesná celoživotní spotřeba by chtěla měsíční 'grant'
  // řádky (kind='grant') — budoucí práce.
  // JEN top-upy/úpravy/refundy (celoživotně, NEEXPIRUJÍ). 'grant' řádky (měsíční
  // příděl plánu) VYNECHÁVÁME — příděl reprezentuje plan.monthlyCreditUsd níže,
  // jinak by se počítal dvakrát a staré granty by se hromadily napříč měsíci.
  const creditRows = await sql<{ sum: number | null }[]>`
    SELECT COALESCE(sum(amount_usd), 0) AS sum
    FROM credit_ledger WHERE user_id = ${userId} AND kind <> 'grant'
  `;
  const topupBalance = Number(creditRows[0]?.sum ?? 0);

  const allowanceUsd = monthlyAllowance + topupBalance;
  const remainingUsd = allowanceUsd - spentUsd;

  return {
    planKey,
    allowanceUsd,
    spentUsd,
    remainingUsd,
    periodStart,
    ok: remainingUsd > 0,
  };
}

/** Rychlá kontrola pro enforcement (orchestrátor / media gate). */
export async function hasCredits(userId: string): Promise<boolean> {
  const b = await creditBalance(userId);
  return b.ok;
}

/** Přidá top-up kredity (idempotentně dle stripeRef). Vrací true, pokud vloženo. */
export async function addTopup(
  userId: string,
  amountUsd: number,
  stripeRef: string | null,
  note?: string,
): Promise<boolean> {
  try {
    await getDb().insert(creditLedger).values({
      userId,
      kind: "topup",
      amountUsd,
      stripeRef,
      note: note ?? null,
    });
    return true;
  } catch (err) {
    // Unikátní stripe_ref → už zpracováno (idempotence webhooku).
    if (String(err).includes("credit_ledger_stripe_ref_uq")) return false;
    throw err;
  }
}

/** Ruční úprava kreditů adminem. */
export async function adminAdjust(userId: string, amountUsd: number, note: string): Promise<void> {
  await getDb().insert(creditLedger).values({ userId, kind: "adjust", amountUsd, note });
}
