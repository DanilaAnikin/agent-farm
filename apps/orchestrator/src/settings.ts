/**
 * Čtení `farm_settings` a odvození vrstvených stropů (farma/uživatel/projekt/přání).
 * farm_settings je key→jsonb; klíč `global_pause` (bool) zastaví celou farmu.
 */
import { getDb, farmSettings, profiles, projects, wishes } from "@farm/db";
import { getPlan, planCaps, effectivePlanKey } from "@farm/billing";
import { eq } from "drizzle-orm";
import { loadConfig } from "@farm/core";
import type { CapSet } from "@farm/core";
import { sumFarmMonth, sumFarmToday } from "./cost.js";

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
 * Útrata se mění po centech, ne skokem, a `SUM` přes ledger není zadarmo; smyčky
 * se ptají každé dvě vteřiny, takže se odpověď dvacet vteřin drží. U denního
 * stropu je to znát nejvíc: ten se reálně trhá (0,58–0,79 USD proti 0,60), takže
 * okno, ve kterém se ještě pracuje po překročení, má být krátké.
 */
const SPEND_TTL_MS = 20_000;
let spendCache: {
  at: number;
  blocked: null | { scope: "den" | "měsíc"; spent: number; cap: number };
} | null = null;
let lastSpendLogAt = 0;
// Sentinel místo `null`: `null` je platný stav („nic neblokuje") a kdyby s ním
// paměť startovala, první vyhodnocení po startu by se rovnalo výchozímu stavu
// a nic by se nezapsalo — v tabulce by zůstal viset marker z MINULÉHO běhu.
let lastMarkerState: string | false | undefined = undefined;

/** Jen pro testy a ruční zásah — vynutí čerstvé přečtení stavu útraty. */
export function resetSpendCache(): void {
  spendCache = null;
}

/** Nezáporné číslo z jsonb, jinak výchozí hodnota. Nula je platný příkaz „neutrácej nic". */
function capFrom(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Zapíše do `farm_settings`, proč se nepracuje — jinak vypadá zavřená brána
 * zvenčí jako zdravá farma, která jen nic nedělá. Hlídače na hostiteli i
 * dashboard tak umí odlišit „stojí to na stropu" od „poskytovatel je dole".
 * Zapisuje se jen při ZMĚNĚ stavu, ne při každé iteraci.
 */
async function markBudgetBlock(state: string | false): Promise<void> {
  if (state === lastMarkerState) return;
  lastMarkerState = state;
  try {
    // `false`, ne `null`: sloupec je NOT NULL a drizzle překládá JS `null` na SQL
    // NULL, ne na jsonb `null`. První verze to dělala, zápis padal na constraint
    // a `catch` to tiše spolkl — marker se nikdy neobjevil a nikdo se to nedozvěděl.
    await getDb()
      .insert(farmSettings)
      .values({ key: "budget_block", value: state })
      .onConflictDoUpdate({ target: farmSettings.key, set: { value: state, updatedAt: new Date() } });
  } catch (err) {
    // Neviditelnost nesmí zastavit rozhodování o penězích — ale nesmí být ani
    // tichá. Zapisuje se jen při změně stavu, takže tohle nezaplaví log.
    console.warn("[rozpočet] zápis budget_block selhal:", String(err).slice(0, 200));
  }
}

/**
 * Smí farma právě teď dělat placenou práci?
 *
 * Sloučeny dvě podmínky, protože obě znamenají totéž: „teď ne".
 *   1. Vypínač — `global_pause` (hlídači) nebo `owner_pause` (člověk).
 *   2. Vyčerpaný měsíční strop.
 *
 * Proč se to ptá NA ÚROVNI SMYČKY a ne před každým voláním modelu: brána zevnitř
 * `chat()` by sice pokryla všech dvanáct míst, která volají model mimo dispatch,
 * jenže vyhozená výjimka se u volajících tváří jako SELHÁNÍ ÚKOLU. Manager by
 * přání natrvalo zaparkoval, judge by zahodil hotovou a už zaplacenou práci,
 * media-pipeline by označil vygenerované assety za vadné. Ochrana peněz by tak
 * vyrobila horší škodu, než jaké měla bránit. Smyčka se rozhodne dřív, než
 * jakoukoli práci začne — a nic se nezahodí.
 */
export async function shouldFarmRun(): Promise<boolean> {
  // Pauza první: je to nejlevnější dotaz a nejčastější důvod, proč se nepracuje.
  if (await isGlobalPaused()) {
    await markBudgetBlock(false);
    return false;
  }

  const now = Date.now();
  if (!spendCache || now - spendCache.at >= SPEND_TTL_MS) {
    const cfg = loadConfig();
    const [rawMonthCap, rawDayCap, month, day] = await Promise.all([
      getSetting<unknown>("farm_monthly_cap_usd", 20),
      getSetting<unknown>("farm_daily_cap_usd", cfg.farmDailyCapUsd),
      sumFarmMonth(),
      sumFarmToday(),
    ]);
    const monthCap = capFrom(rawMonthCap, 20);
    const dayCap = capFrom(rawDayCap, cfg.farmDailyCapUsd);

    // Měsíční strop se testuje první: je to nejtvrdší hranice a vyčerpaný měsíc
    // nemá smysl přebíjet tím, že dnešní okno je zrovna prázdné.
    let blocked: { scope: "den" | "měsíc"; spent: number; cap: number } | null = null;
    if (month >= monthCap) blocked = { scope: "měsíc", spent: month, cap: monthCap };
    else if (day >= dayCap) blocked = { scope: "den", spent: day, cap: dayCap };

    spendCache = { at: now, blocked };
  }

  const blocked = spendCache.blocked;
  if (!blocked) {
    await markBudgetBlock(false);
    return true;
  }

  await markBudgetBlock(`${blocked.scope}: ${blocked.spent.toFixed(2)}/${blocked.cap.toFixed(2)} USD`);
  if (now - lastSpendLogAt > 60 * 60_000) {
    lastSpendLogAt = now;
    console.warn(
      `[rozpočet] Vyčerpaný strop na ${blocked.scope} ` +
        `(${blocked.spent.toFixed(2)} / ${blocked.cap.toFixed(2)} USD) — farma nepracuje.`,
    );
  }
  return false;
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
