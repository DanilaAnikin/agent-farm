/**
 * Čtení `farm_settings` a odvození vrstvených stropů (farma/uživatel/projekt/přání).
 * farm_settings je key→jsonb; klíč `global_pause` (bool) zastaví celou farmu.
 */
import { getDb, farmSettings, profiles, projects, wishes } from "@farm/db";
import { getPlan, planCaps, effectivePlanKey } from "@farm/billing";
import { eq } from "drizzle-orm";
import { loadConfig } from "@farm/core";
import type { CapSet } from "@farm/core";

/** Vrátí hodnotu nastavení z farm_settings (nebo fallback, když chybí). */
export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const rows = await getDb()
    .select({ value: farmSettings.value })
    .from(farmSettings)
    .where(eq(farmSettings.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return fallback;
  return row.value as T;
}

/**
 * Je celá farma pozastavena?
 *
 * Dva klíče schválně, protože pauzy mají dva různé majitele s různou životností:
 *
 *   `global_pause` — provozní. Zapínají a vypínají ji automatické hlídače
 *                    (offpeak, credit_guard, budget_month) a poznají svou vlastní
 *                    podle `pause_source`.
 *   `owner_pause`  — člověk. Hlídače se jí NIKDY nedotknou.
 *
 * Dřív existoval jen `global_pause` a rozlišovat se to mělo podle `pause_source`.
 * Jenže ten nezapisoval ani jeden aplikační zapisovatel — dashboard ani /kill —
 * takže vznikl tenhle deterministický scénář: farma stojí kvůli špičce
 * (`pause_source='offpeak'`), člověk zmáčkne kill, `global_pause` už je true
 * (zápis je no-op), značka zůstane `offpeak` — a ve 4:00 UTC ji offpeak jako svou
 * vlastní zase pustí. Vlastníkova pauza tedy tiše vyprchala.
 */
export async function isGlobalPaused(): Promise<boolean> {
  const [global_, owner] = await Promise.all([
    getSetting<boolean>("global_pause", false),
    getSetting<boolean>("owner_pause", false),
  ]);
  return Boolean(global_) || Boolean(owner);
}

/**
 * Autopilot pro daný projekt: přeskočit schvalovací bránu specifikace a jet
 * rovnou spec → plán → exekuce. Zapnutý když má projekt trust_mode NEBO je
 * globální farm_settings.autopilot = true. (Concierge chování — dělat rozumné
 * předpoklady a neblokovat na člověku — platí VŽDY, i bez autopilotu.)
 */
export async function isAutopilot(trustMode: boolean): Promise<boolean> {
  if (trustMode) return true;
  return getSetting<boolean>("autopilot", false);
}

/**
 * Sestaví vrstvené stropy pro rozpočtovou bránu.
 * Farma: farm_settings.farm_daily_cap_usd → jinak config default.
 * Uživatel: profiles.daily_cap_usd. Projekt: projects.daily_cap_usd. Přání: wishes.budget_usd.
 */
export async function getCaps(
  userId: string,
  projectId: string,
  wishId?: string | null,
): Promise<CapSet> {
  const cfg = loadConfig();
  const farmDailyCapUsd = await getSetting<number>("farm_daily_cap_usd", cfg.farmDailyCapUsd);
  /*
    Výchozích 20 USD je limit, který si stanovil vlastník farmy. Změnit jde bez
    zásahu do kódu přes farm_settings.farm_monthly_cap_usd.

    Hodnota se OVĚŘUJE, protože `getSetting` vrací syrové jsonb bez kontroly typu.
    Kdyby tam někdo uložil řetězec `"20"` nebo objekt, porovnání v `checkBudget`
    by dalo NaN, podmínka by nikdy neplatila a strop by tiše zmizel — tedy
    fail-open přesně u té vrstvy, která má chránit peníze. Při nesmyslné hodnotě
    se proto vrací výchozích 20, ne nic.
  */
  const rawMonthlyCap = await getSetting<unknown>("farm_monthly_cap_usd", 20);
  const parsedMonthlyCap = Number(rawMonthlyCap);
  const farmMonthlyCapUsd =
    Number.isFinite(parsedMonthlyCap) && parsedMonthlyCap > 0 ? parsedMonthlyCap : 20;

  // Uživatelský denní strop se řídí PLÁNEM (billing); admin může přepsat přes caps_override.
  // EFEKTIVNÍ plán: při selhané platbě (past_due/unpaid) degradace na free — konzistentní
  // s creditBalance, jinak by delikventní účet držel plný denní strop placeného tieru.
  const userRows = await getDb()
    .select({ planKey: profiles.planKey, subStatus: profiles.subscriptionStatus, override: profiles.capsOverride })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const userDailyCapUsd = userRows[0]
    ? planCaps(getPlan(effectivePlanKey(userRows[0].planKey, userRows[0].subStatus)), userRows[0].override).dailyCapUsd
    : cfg.defaultUserDailyCapUsd;

  const projRows = await getDb()
    .select({ cap: projects.dailyCapUsd })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectDailyCapUsd = projRows[0]?.cap ?? cfg.defaultProjectDailyCapUsd;

  let wishBudgetUsd: number | undefined;
  if (wishId) {
    const wishRows = await getDb()
      .select({ budget: wishes.budgetUsd })
      .from(wishes)
      .where(eq(wishes.id, wishId))
      .limit(1);
    wishBudgetUsd = wishRows[0]?.budget;
  }

  return { farmMonthlyCapUsd, farmDailyCapUsd, userDailyCapUsd, projectDailyCapUsd, wishBudgetUsd };
}
