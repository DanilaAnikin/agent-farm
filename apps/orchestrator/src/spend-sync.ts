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
 * Watermark (max endTime) držíme ve farm_settings, ať nečteme celou tabulku pořád.
 * První běh backfilluje celou historii (ts řádků = reálný startTime).
 *
 * Proč endTime s překryvem, ne startTime: LiteLLM zapíše řádek až po DOKONČENÍ
 * requestu, ale se startTime z jeho začátku. Dlouhý request (až ~15 min) tak do
 * tabulky přibyl se startTime STARŠÍM než watermark, který mezitím posunuly kratší
 * requesty — a filtr `startTime > watermark` ho navždy přeskočil (v září 13 logů
 * za 0,0629 US$). Teď se čte `endTime > watermark − 20 min`; překryv je bezpečný,
 * protože dedup přes ref_id níže nic nezapočítá dvakrát.
 *
 * Atribuce: workeři i orchestrátor volají LiteLLM master klíčem (jednouživatelská
 * farma), takže user v logu je „default_user_id" → mapujeme na ownera. Scope se
 * odvozuje z requester_ip (workernet = agent 'attempt', jinak 'system').
 */
import postgres from "postgres";
import { getSql, getDb, costLedger } from "@farm/db";
import { logEventDeduped } from "./events.js";

const WATERMARK_KEY = "litellm_spend_watermark";
const BATCH = 500;
const WORKERNET_PREFIX = process.env.WORKERNET_IP_PREFIX ?? "192.168.32.";
// Překryv čtení: musí být delší než nejdelší request (v produkci max ~15 min).
const OVERLAP_MINUTES = 20;

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
  startTime: string; // castnuto na ::text v SQL → "YYYY-MM-DD HH:MM:SS.mmm" (UTC)
  endTime: string; // COALESCE(endTime, startTime)::text, stejný formát
  status: string | null;
  spend: number | null;
  model: string | null;
  custom_llm_provider: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  metadata: Record<string, unknown> | null;
  requester_ip_address: string | null;
  user: string | null;
}

/** "YYYY-MM-DD HH:MM:SS.mmm" (UTC bez zóny) → Date; nevalidní → null. */
function parseUtc(text: string | null | undefined): Date | null {
  if (!text) return null;
  const d = new Date(`${text.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
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

/**
 * Projekt z `metadata.spend_logs_metadata`, který posílá `chat()` z @farm/llm u
 * přímých volání orchestrátoru (manager, judge, refill, suggestions).
 *
 * NEHÁDÁ SE: když LiteLLM klíč nevrátí (starší logy, jiná verze proxy, volání bez
 * metadat), zůstane project_id NULL a dashboard položku ukáže jako „Systém
 * (plánování a hodnocení)", aby součet grafu seděl s celkem. Atribuce přes hash
 * efemérního klíče je záměrně odložená.
 */
function systemProjectId(meta: Record<string, unknown> | null): string | null {
  const slm = meta?.spend_logs_metadata;
  if (!slm || typeof slm !== "object") return null;
  const rec = slm as Record<string, unknown>;
  return asUuid(rec.projectId) ?? asUuid(rec.project_id);
}

// Odmítnuté požadavky (status=failure, spend=0) nasčítané od posledního zápisu události.
let pendingRejected = 0;

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
  const watermarkMs = new Date(watermark).getTime();

  // Watermark je ISO s „Z"; ::timestamptz AT TIME ZONE 'UTC' ho převede na naivní
  // UTC čas, ve kterém LiteLLM ukládá startTime/endTime.
  const selectLogs = (overlapMinutes: number) => lsql<SpendRow[]>`
    SELECT request_id, "startTime"::text AS "startTime",
           COALESCE("endTime", "startTime")::text AS "endTime",
           status, spend, model, custom_llm_provider,
           prompt_tokens, completion_tokens, metadata, requester_ip_address, "user"
    FROM "LiteLLM_SpendLogs"
    WHERE COALESCE("endTime", "startTime") >
          (${watermark}::timestamptz AT TIME ZONE 'UTC') - make_interval(mins => ${overlapMinutes})
    ORDER BY COALESCE("endTime", "startTime") ASC
    LIMIT ${BATCH}
  `;
  let logs = await selectLogs(OVERLAP_MINUTES);
  // Pojistka proti zacyklení: kdyby se do okna překryvu vešla celá dávka, watermark
  // by se neposunul a každý běh by četl tytéž řádky. Pak čti bez překryvu.
  const maxEndOf = (rows: SpendRow[]) =>
    rows.reduce((m, l) => Math.max(m, parseUtc(l.endTime)?.getTime() ?? 0), 0);
  if (logs.length === BATCH && maxEndOf(logs) <= watermarkMs) {
    logs = await selectLogs(0);
  }
  if (logs.length === 0) return;

  // Idempotence — vyřaď request_id, co už v cost_ledger jsou. Ptáme se nad VŠEMI
  // načtenými id (i nad těmi z okna překryvu), jinak by překryv zdvojil útratu.
  const ids = logs.map((l) => asUuid(l.request_id)).filter((x): x is string => x !== null);
  const existing = ids.length
    ? await db<{ ref_id: string }[]>`
        SELECT ref_id::text AS ref_id FROM cost_ledger WHERE ref_id::text = ANY(${ids})
      `
    : [];
  const seen = new Set(existing.map((e) => e.ref_id));

  // Atribuce na projekt/přání: spend log koreluj s pokusem, který v jeho čase běžel.
  // (cap=1 → v daný okamžik běží ≤1 pokus → jednoznačná shoda.) Načti pokusy
  // překrývající časové okno dávky JEDNÍM dotazem a matchuj v paměti.
  const times = logs.map((l) => parseUtc(l.startTime)?.getTime()).filter((t): t is number => t !== undefined);
  const minT = times.length ? new Date(Math.min(...times)) : new Date(0);
  const maxT = times.length ? new Date(Math.max(...times)) : new Date();
  const attemptRows = await db<
    { project_id: string; wish_id: string | null; started_at: Date; finished_at: Date | null }[]
  >`
    SELECT t.project_id, t.wish_id, a.started_at, a.finished_at
    FROM attempts a JOIN tasks t ON t.id = a.task_id
    WHERE a.started_at <= ${maxT.toISOString()}::timestamptz
      AND (a.finished_at IS NULL OR a.finished_at >= ${minT.toISOString()}::timestamptz)
  `;
  const SLACK = 5000; // ms tolerance na okrajích pokusu
  function attribute(tms: number): { projectId: string | null; wishId: string | null } {
    for (const a of attemptRows) {
      const s = new Date(a.started_at).getTime();
      const f = a.finished_at ? new Date(a.finished_at).getTime() : Date.now();
      if (tms >= s - SLACK && tms <= f + SLACK)
        return { projectId: a.project_id, wishId: a.wish_id };
    }
    return { projectId: null, wishId: null };
  }

  // Systémová útrata z metadat: ověř, že projekt pořád existuje (FK na projects —
  // smazaný projekt by jinak shodil insert celé dávky).
  const metaProjectIds = [
    ...new Set(logs.map((l) => systemProjectId(l.metadata)).filter((x): x is string => x !== null)),
  ];
  const knownProjects = new Set(
    metaProjectIds.length
      ? (
          await db<{ id: string }[]>`SELECT id::text AS id FROM projects WHERE id::text = ANY(${metaProjectIds})`
        ).map((r) => r.id)
      : [],
  );

  const toInsert: (typeof costLedger.$inferInsert)[] = [];
  const wishDelta = new Map<string, number>();
  let maxTs = watermark;
  let rejected = 0;
  for (const l of logs) {
    const start = parseUtc(l.startTime);
    const end = parseUtc(l.endTime) ?? start;
    if (!start || !end) continue; // nevalidní čas přeskoč (nikdy nekrasne loop)
    const endIso = end.toISOString();
    if (endIso > maxTs) maxTs = endIso;
    const refId = asUuid(l.request_id);
    if (refId && seen.has(refId)) continue;
    // Bez UUID nejde deduplikovat: v okně překryvu by se řádek přičetl při každém
    // běhu. Takový řádek bereme jen jednou — když skončil až po watermarku.
    if (!refId && end.getTime() <= watermarkMs) continue;
    const cost = Number(l.spend) || 0;

    // Odmítnutý request (rozpočtová brána, per-pokus klíč, výpadek poskytovatele)
    // nic nestál. V ledgeru dělal řádky „prázdný poskytovatel · 0 tokenů · 0,00 US$",
    // které v UI vypadaly jako skutečná práce. Počítáme je jen do souhrnné události.
    if (l.status === "failure" && cost === 0) {
      if (end.getTime() > watermarkMs) rejected += 1;
      continue;
    }

    const ip = String(l.requester_ip_address ?? "");
    const scope: "attempt" | "system" = ip.startsWith(WORKERNET_PREFIX) ? "attempt" : "system";
    let attr: { projectId: string | null; wishId: string | null };
    if (scope === "attempt") {
      attr = attribute(start.getTime());
    } else {
      // Jen projekt, ne přání: systémová útrata se do wishes.spent_usd dřív nepočítala
      // a přidat ji by tiše změnilo, kdy přání narazí na svůj rozpočet.
      const pid = systemProjectId(l.metadata);
      attr = { projectId: pid && knownProjects.has(pid) ? pid : null, wishId: null };
    }
    if (scope === "attempt" && attr.wishId) {
      wishDelta.set(attr.wishId, (wishDelta.get(attr.wishId) ?? 0) + cost);
    }
    toInsert.push({
      ts: start,
      userId: asUuid(l.user) ?? owner,
      projectId: attr.projectId,
      scope,
      refId,
      provider: l.custom_llm_provider || null,
      model: l.model || null,
      tokensIn: l.prompt_tokens ?? 0,
      tokensOut: l.completion_tokens ?? 0,
      tokensCached: cachedTokens(l.metadata),
      costUsd: cost,
      isShadow: false,
    });
  }

  if (toInsert.length > 0) {
    await getDb().insert(costLedger).values(toInsert);
  }
  // Propiš přírůstky útraty do přání (spentUsd). Idempotentní: každý spend log
  // (refId) se započítá právě jednou (dedup výše).
  for (const [wishId, delta] of wishDelta) {
    await db`UPDATE wishes SET spent_usd = COALESCE(spent_usd, 0) + ${delta} WHERE id = ${wishId}::uuid`;
  }

  await db`
    INSERT INTO farm_settings (key, value, updated_at)
    VALUES (${WATERMARK_KEY}, ${JSON.stringify(maxTs)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;

  if (rejected > 0 || pendingRejected > 0) {
    const count = pendingRejected + rejected;
    const written = await logEventDeduped("budget_rejected", "spend-sync", {
      level: "warn",
      message: `LiteLLM odmítl ${count} požadavků bez útraty (do nákladů se nezapisují).`,
      data: { count },
    });
    pendingRejected = written ? 0 : count;
  }
}
