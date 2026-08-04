/**
 * Most LiteLLM_SpendLogs → cost_ledger.
 *
 * LiteLLM loguje reálný spend do VLASTNÍ DB (`litellm`, tabulka LiteLLM_SpendLogs),
 * ale dashboard i rozpočtové brány (spendSnapshot) čtou app tabulku `cost_ledger`.
 * Bez tohohle mostu je cost_ledger prázdný → dashboard ukazuje $0 A denní strop se
 * fakticky nevynucuje (spendSnapshot vrací 0). Tenhle loop periodicky přenáší nové
 * spend-logy do cost_ledger.
 *
 * Idempotence: refId = request_id (uuid); už přenesené request_id přeskakujeme.
 * Watermark (max startTime) držíme ve farm_settings, ať nečteme celou tabulku pořád.
 * První běh backfilluje celou historii (ts řádků = reálný startTime).
 *
 * Atribuce: workeři i orchestrátor volají LiteLLM master klíčem (jednouživatelská
 * farma), takže user v logu je „default_user_id" → mapujeme na ownera. Scope se
 * odvozuje z requester_ip (workernet = agent 'attempt', jinak 'system').
 */
import postgres from "postgres";
import { getSql, getDb, costLedger } from "@farm/db";

const WATERMARK_KEY = "litellm_spend_watermark";
const BATCH = 500;
const WORKERNET_PREFIX = process.env.WORKERNET_IP_PREFIX ?? "192.168.32.";

let _litellmSql: ReturnType<typeof postgres> | null = null;
function litellmSql() {
  if (!_litellmSql) {
    let url = process.env.LITELLM_DATABASE_URL;
    if (!url) {
      // Odvoď z DATABASE_URL (stejný server, jiná databáze).
      const base = process.env.DATABASE_URL;
      if (!base) throw new Error("Ani LITELLM_DATABASE_URL, ani DATABASE_URL nejsou nastavené.");
      const u = new URL(base);
      u.pathname = "/litellm";
      url = u.toString();
    }
    _litellmSql = postgres(url, { max: 3, idle_timeout: 30, prepare: false });
  }
  return _litellmSql;
}

let _ownerId: string | null = null;
async function ownerUserId(): Promise<string | null> {
  if (_ownerId) return _ownerId;
  const envId = process.env.FARM_OWNER_USER_ID;
  if (envId) {
    _ownerId = envId;
    return _ownerId;
  }
  const rows = await getSql()<{ user_id: string }[]>`
    SELECT user_id FROM profiles LIMIT 1
  `;
  _ownerId = rows[0]?.user_id ?? null;
  return _ownerId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asUuid(s: unknown): string | null {
  return typeof s === "string" && UUID_RE.test(s) ? s : null;
}

interface SpendRow {
  request_id: string | null;
  startTime: string | Date;
  spend: number | null;
  model: string | null;
  custom_llm_provider: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  metadata: Record<string, unknown> | null;
  requester_ip_address: string | null;
  user: string | null;
}

function cachedTokens(meta: Record<string, unknown> | null): number {
  if (!meta) return 0;
  try {
    const auv = meta.additional_usage_values as { cache_read_input_tokens?: number } | undefined;
    if (typeof auv?.cache_read_input_tokens === "number") return auv.cache_read_input_tokens;
    const uo = meta.usage_object as
      | { prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    return uo?.prompt_tokens_details?.cached_tokens ?? 0;
  } catch {
    return 0;
  }
}

/** Jedna iterace: přenes nové LiteLLM spend-logy do cost_ledger. */
export async function runSpendSyncOnce(): Promise<void> {
  const owner = await ownerUserId();
  const lsql = litellmSql();
  const db = getSql();

  const wmRows = await db<{ value: unknown }[]>`
    SELECT value FROM farm_settings WHERE key = ${WATERMARK_KEY}
  `;
  const watermark =
    typeof wmRows[0]?.value === "string" ? (wmRows[0]!.value as string) : "1970-01-01T00:00:00Z";

  const logs = await lsql<SpendRow[]>`
    SELECT request_id, "startTime", spend, model, custom_llm_provider,
           prompt_tokens, completion_tokens, metadata, requester_ip_address, "user"
    FROM "LiteLLM_SpendLogs"
    WHERE "startTime" > ${watermark}::timestamp
    ORDER BY "startTime" ASC
    LIMIT ${BATCH}
  `;
  if (logs.length === 0) return;

  // Idempotence — vyřaď request_id, co už v cost_ledger jsou.
  const ids = logs.map((l) => asUuid(l.request_id)).filter((x): x is string => x !== null);
  const existing = ids.length
    ? await db<{ ref_id: string }[]>`
        SELECT ref_id::text AS ref_id FROM cost_ledger WHERE ref_id::text = ANY(${ids})
      `
    : [];
  const seen = new Set(existing.map((e) => e.ref_id));

  const toInsert: (typeof costLedger.$inferInsert)[] = [];
  let maxTs = watermark;
  for (const l of logs) {
    const iso = new Date(`${String(l.startTime).replace(" ", "T")}Z`).toISOString();
    if (iso > maxTs) maxTs = iso;
    const refId = asUuid(l.request_id);
    if (refId && seen.has(refId)) continue;
    const ip = String(l.requester_ip_address ?? "");
    const scope: "attempt" | "system" = ip.startsWith(WORKERNET_PREFIX) ? "attempt" : "system";
    toInsert.push({
      ts: new Date(iso),
      userId: asUuid(l.user) ?? owner,
      projectId: null,
      scope,
      refId,
      provider: l.custom_llm_provider ?? null,
      model: l.model ?? null,
      tokensIn: l.prompt_tokens ?? 0,
      tokensOut: l.completion_tokens ?? 0,
      tokensCached: cachedTokens(l.metadata),
      costUsd: Number(l.spend) || 0,
      isShadow: false,
    });
  }

  if (toInsert.length > 0) {
    await getDb().insert(costLedger).values(toInsert);
  }

  await db`
    INSERT INTO farm_settings (key, value, updated_at)
    VALUES (${WATERMARK_KEY}, ${JSON.stringify(maxTs)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}
