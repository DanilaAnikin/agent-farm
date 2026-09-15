/**
 * Sync stropů do LiteLLM (OVERVIEW §5.2 / §5.4). Sleduje profiles/projects a
 * změny denních stropů propisuje do LiteLLM admin API (per-user max_budget).
 * Best-effort: chyby jen logujeme, farmu nezastavují. Aby se API nespamovalo,
 * držíme v paměti poslední odeslané hodnoty a posíláme jen změny.
 *
 * Autoritativní peněžní brána je rozpočtový hlídač v LiteLLM (farm_budget_guard)
 * a smyčková brána `shouldFarmRun`. Tenhle per-user `max_budget` je jen DRUHÁ
 * pojistka — nesmí ale lhát: dřív se posílal `profiles.daily_cap_usd` (15 USD),
 * tedy 25× víc než skutečný denní strop farmy (0,60 USD). Posílá se proto
 * nejnižší z platných stropů. Hodnota tím může jen KLESNOUT, nikdy nevzroste.
 *
 * POZOR: endpointy LiteLLM admin API se mezi verzemi mění. Cesty jsou na jednom
 * místě (ENDPOINTS) — při upgradu LiteLLM ověř /user/update a /user/new.
 */
import { getDb, profiles } from "@farm/db";
import { getPlan, planCaps, effectivePlanKey } from "@farm/billing";
import { loadConfig } from "@farm/core";
import { getSetting } from "./settings.js";

const ENDPOINTS = {
  userUpdate: (base: string) => `${base}/user/update`,
} as const;

function baseUrl(): string {
  return process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
}

function masterKey(): string | null {
  return process.env.LITELLM_MASTER_KEY ?? null;
}

// userId → naposledy odeslaný denní strop (aby se posílaly jen změny).
const lastSyncedUserCap = new Map<string, number>();

/** Nezáporné konečné číslo, jinak null (null se do minima nepočítá). */
function finiteCap(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Jedna iterace sync loopu. */
export async function runLitellmSyncOnce(): Promise<void> {
  const key = masterKey();
  if (!key) return; // bez master key nemáme kam syncovat

  const cfg = loadConfig();
  const farmDailyCap =
    finiteCap(await getSetting<unknown>("farm_daily_cap_usd", cfg.farmDailyCapUsd)) ?? cfg.farmDailyCapUsd;

  const rows = await getDb()
    .select({
      userId: profiles.userId,
      cap: profiles.dailyCapUsd,
      planKey: profiles.planKey,
      subStatus: profiles.subscriptionStatus,
      override: profiles.capsOverride,
    })
    .from(profiles);

  for (const r of rows) {
    // Stejný výpočet uživatelského stropu jako getCaps (plán + ruční přepis).
    const planCap = planCaps(getPlan(effectivePlanKey(r.planKey, r.subStatus)), r.override).dailyCapUsd;
    const candidates = [finiteCap(r.cap), finiteCap(planCap), farmDailyCap].filter(
      (n): n is number => n !== null,
    );
    // farmDailyCap je vždy konečné číslo, takže minimum existuje vždy.
    const cap = Math.min(...candidates);
    const prev = lastSyncedUserCap.get(r.userId);
    if (prev !== undefined && prev === cap) continue; // beze změny
    const ok = await pushUserBudget(r.userId, cap, key);
    if (ok) lastSyncedUserCap.set(r.userId, cap);
  }
}

/** Pošle per-user denní strop do LiteLLM (max_budget + denní reset). Best-effort. */
async function pushUserBudget(userId: string, capUsd: number, key: string): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINTS.userUpdate(baseUrl()), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        user_id: userId,
        max_budget: capUsd,
        budget_duration: "1d",
      }),
    });
    if (!res.ok) {
      console.error(`[litellm-sync] user ${userId} strop selhal: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[litellm-sync] user ${userId} strop výjimka:`, err);
    return false;
  }
}
