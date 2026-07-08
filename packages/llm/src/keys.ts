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

export async function mintEphemeralKey(opts: EphemeralKeyOptions): Promise<EphemeralKey> {
  const res = await fetch(`${baseUrl()}/key/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterKey()}`,
    },
    body: JSON.stringify({
      max_budget: opts.maxBudgetUsd,
      duration: opts.duration ?? "35m",
      models: opts.models ?? WORKER_MODELS,
      metadata: opts.metadata ?? {},
    }),
  });
  if (!res.ok) {
    throw new Error(`mintEphemeralKey failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { key: string; expires?: string };
  return { key: json.key, expires: json.expires };
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
