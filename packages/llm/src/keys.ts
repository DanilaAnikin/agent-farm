/**
 * Ephemeral per-attempt virtuální klíče přes LiteLLM admin API.
 * Orchestrátor před pokusem workera vytvoří klíč s max_budget a expirací,
 * injektuje ho do opencode session a po skončení revokuje.
 */
import { MODELS } from "./models.js";

// Least-privilege default: worker klíč smí JEN worker model tiery. Prázdné pole
// LiteLLM chápe jako „všechny modely" — to bychom nechtěli (klíč by pustil i
// manager/judge/media modely). Kdo potřebuje jiné, předá opts.models explicitně.
const WORKER_MODELS = [MODELS.worker, MODELS.workerHard, MODELS.workerFallback];

function baseUrl(): string {
  return process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
}

function masterKey(): string {
  const k = process.env.LITELLM_MASTER_KEY;
  if (!k) throw new Error("LITELLM_MASTER_KEY není nastavena.");
  return k;
}

export interface EphemeralKeyOptions {
  maxBudgetUsd: number;
  /** Doba platnosti, např. "35m". */
  duration?: string;
  /** Na které logické modely klíč smí. */
  models?: string[];
  metadata?: Record<string, unknown>;
}

export interface EphemeralKey {
  key: string;
  expires?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Vytvoří ephemeral klíč. RETRY na connection chyby ("fetch failed"/ECONNREFUSED)
 * a 5xx z LiteLLM — bez toho každý transient výpadek litellm shodil celý dispatch
 * pokus → requeue (byla to hlavní příčina 4260× "dispatch_error: fetch failed" +
 * 10k requeue churn). 4xx (např. špatný master key) je trvalé → nezkoušíme dokola.
 */
export async function mintEphemeralKey(opts: EphemeralKeyOptions): Promise<EphemeralKey> {
  const body = JSON.stringify({
    max_budget: opts.maxBudgetUsd,
    duration: opts.duration ?? "35m",
    models: opts.models ?? WORKER_MODELS,
    metadata: opts.metadata ?? {},
  });
  const MAX = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/key/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterKey()}` },
        body,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        // 5xx = LiteLLM dočasně nezdravý → zkus znovu; 4xx = trvalá chyba.
        if (res.status >= 500 && attempt < MAX - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`mintEphemeralKey failed: ${res.status} ${txt}`);
      }
      const json = (await res.json()) as { key: string; expires?: string };
      return { key: json.key, expires: json.expires };
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      const isConn =
        msg.includes("fetch failed") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ECONNRESET") ||
        msg.includes("socket") ||
        msg.includes("aborted") ||
        msg.includes("timeout");
      if (!isConn || attempt >= MAX - 1) throw e;
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("mintEphemeralKey: vyčerpány pokusy");
}

export async function revokeKey(key: string): Promise<void> {
  await fetch(`${baseUrl()}/key/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterKey()}`,
    },
    body: JSON.stringify({ keys: [key] }),
  }).catch(() => {
    /* best-effort; klíč stejně brzy expiruje */
  });
}
