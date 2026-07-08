/**
 * Sync stropů do LiteLLM (OVERVIEW §5.2 / §5.4). Sleduje profiles/projects a
 * změny denních stropů propisuje do LiteLLM admin API (per-user max_budget).
 * Best-effort: chyby jen logujeme, farmu nezastavují. Aby se API nespamovalo,
 * držíme v paměti poslední odeslané hodnoty a posíláme jen změny.
 *
 * POZOR: endpointy LiteLLM admin API se mezi verzemi mění. Cesty jsou na jednom
 * místě (ENDPOINTS) — při upgradu LiteLLM ověř /user/update a /user/new.
 */
import { getDb, profiles } from "@farm/db";

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

/** Jedna iterace sync loopu. */
export async function runLitellmSyncOnce(): Promise<void> {
  const key = masterKey();
  if (!key) return; // bez master key nemáme kam syncovat

  const rows = await getDb()
    .select({ userId: profiles.userId, cap: profiles.dailyCapUsd })
    .from(profiles);

  for (const r of rows) {
    const prev = lastSyncedUserCap.get(r.userId);
    if (prev !== undefined && prev === r.cap) continue; // beze změny
    const ok = await pushUserBudget(r.userId, r.cap, key);
    if (ok) lastSyncedUserCap.set(r.userId, r.cap);
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
