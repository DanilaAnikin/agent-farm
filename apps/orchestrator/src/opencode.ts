/**
 * Tenký HTTP klient k opencode serveru běžícímu ve worker kontejneru.
 * Záměrně NEpoužíváme @opencode-ai/sdk (vyhýbáme se riziku nekompatibilních typů)
 * a mluvíme přímo s dokumentovaným REST API.
 *
 * POZOR: endpointy níže zrcadlí opencode REST API (POST /session, POST
 * /session/:id/message, GET /event jako SSE, POST /session/:id/abort).
 * Konkrétní tvar se může lišit podle nainstalované verze opencode — při upgradu
 * ověř a případně uprav cesty a tvar payloadu na jednom místě (ENDPOINTS).
 */

import { Agent } from "undici";
import { setTimeout as delay } from "node:timers/promises";

const ENDPOINTS = {
  createSession: (base: string) => `${base}/session`,
  message: (base: string, sessionId: string) => `${base}/session/${sessionId}/message`,
  events: (base: string) => `${base}/event`,
  abort: (base: string, sessionId: string) => `${base}/session/${sessionId}/abort`,
} as const;

// KRITICKÉ: prompt() blokuje po celou dobu běhu agenta (klidně ATTEMPT_WALL_CLOCK_MIN,
// default 30 min) a /event je dlouho žijící SSE stream. Node global fetch (undici) má
// ale defaultní headersTimeout i bodyTimeout 300 s → jakýkoli pokus delší než 5 min
// umřel na "TypeError: fetch failed" (to byla příčina 463 „infra" selhání → parked →
// paused). Vlastní dispatcher timeouty vypíná (0 = bez limitu); skutečný limit řídí
// wall-clock guard + AbortSignal v dispatch.ts (runWithLimits).
const workerDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
});

// `dispatcher` není v standardním RequestInit typu (undici rozšíření Node fetche).
type FetchInit = RequestInit & { dispatcher?: unknown };

export interface OpencodeSession {
  id: string;
}

export interface PromptInput {
  agent: string;
  model: string;
  text: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface PromptResult {
  /** Souhrnný text finální odpovědi (pro output_summary a loop detection). */
  text: string;
  raw: unknown;
}

/** Provider failures can be embedded in a successful opencode HTTP response. */
export class OpencodePromptError extends Error {
  constructor(readonly errorType: string, readonly status?: number, budgetExceeded = false) {
    // Never copy provider response bodies: they can contain the request or credentials.
    super(`opencode prompt failed: ${errorType}${status ? ` (provider status ${status})` : ""}${budgetExceeded ? ": budget exceeded" : ""}`);
    this.name = "OpencodePromptError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Validate completion before dispatch treats it as work ready for judging. */
export function parsePromptResponse(value: unknown): PromptResult {
  const raw = record(value);
  if (!raw) throw new OpencodePromptError("InvalidResponse");
  const info = record(raw.info);
  const error = info?.error ?? raw.error;
  if (error !== undefined && error !== null) {
    const details = record(error);
    const data = record(details?.data);
    const code = data?.statusCode ?? details?.statusCode ?? details?.status;
    const status = typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599
      ? code : undefined;
    const name = typeof details?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(details.name)
      ? details.name : "ProviderError";
    const diagnostic = [typeof error === "string" ? error : "", details?.message, data?.message, data?.responseBody]
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.slice(0, 16_384)).join(" ");
    const budgetExceeded = status === 402 || /budget.{0,40}(exceed|exhaust|limit|unavailable|pause)|budget_exceeded/i.test(diagnostic);
    throw new OpencodePromptError(name, status, budgetExceeded);
  }
  if (!info && !Array.isArray(raw.parts) && typeof raw.text !== "string"
      && typeof record(raw.message)?.content !== "string") {
    throw new OpencodePromptError("InvalidResponse");
  }
  return { text: extractText(raw), raw };
}

/** Obecná SSE událost z opencode /event streamu. */
export interface OpencodeEvent {
  type?: string;
  [key: string]: unknown;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
    dispatcher: workerDispatcher,
  } as FetchInit);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`opencode ${url} selhalo: ${res.status} ${t}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

export interface SessionStartupLimits {
  requestMs?: number;
  totalMs?: number;
  retryDelayMs?: number;
}

/** Session startup has its own deadline; long-running prompts use separate limits. */
export async function createSession(
  baseUrl: string,
  signal?: AbortSignal,
  limits: SessionStartupLimits = {},
): Promise<OpencodeSession> {
  const overall = AbortSignal.timeout(limits.totalMs ?? 90_000);
  const startup = signal ? AbortSignal.any([signal, overall]) : overall;
  let ready = process.env.LOCAL_RUNTIME === "1";
  for (;;) {
    startup.throwIfAborted();
    const request = AbortSignal.timeout(limits.requestMs ?? 20_000);
    try {
      const requestSignal = AbortSignal.any([startup, request]);
      if (!ready) {
        // Cold 1.18.x servers can hang their first session request during initialization.
        // Warm configuration only after the server is listening; neither GET calls a model.
        for (const endpoint of ["/global/health", "/config"]) {
          const res = await fetch(`${baseUrl}${endpoint}`, { signal: requestSignal, dispatcher: workerDispatcher } as FetchInit);
          if (!res.ok) throw new Error(`opencode startup readiness failed: HTTP ${res.status}`);
          await res.json();
        }
        ready = true;
      }
      const json = await postJson<{ id?: string; sessionID?: string }>(
        ENDPOINTS.createSession(baseUrl), {}, requestSignal,
      );
      startup.throwIfAborted();
      const id = json.id ?? json.sessionID;
      if (!id) throw new Error("opencode createSession nevrátil id session.");
      return { id };
    } catch (err) {
      // Never retry past cancellation/deadline, including cancellation during backoff.
      startup.throwIfAborted();
      const msg = String((err as { message?: string })?.message ?? err);
      const isConn = /fetch failed|ECONNREFUSED|ECONNRESET|socket/.test(msg);
      if (!request.aborted && !isConn) throw err;
      await delay(limits.retryDelayMs ?? 2_000, undefined, { signal: startup });
    }
  }
}

/**
 * Pošle prompt do session a počká na finální odpověď.
 * Vybraný agent (worker-build / worker-fix) a logický model (přes LiteLLM) se
 * předávají v těle; per-attempt klíč jde přes hlavičku (opencode ho předá do LiteLLM).
 */
export async function prompt(
  baseUrl: string,
  sessionId: string,
  input: PromptInput,
): Promise<PromptResult> {
  const res = await fetch(ENDPOINTS.message(baseUrl, sessionId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    },
    body: JSON.stringify({
      // opencode 1.18.x: model MUSÍ být objekt {providerID, modelID}, ne string.
      model: { providerID: "farm", modelID: input.model },
      // worker-build/worker-fix nejsou definované agenty v opencode.json →
      // mapujeme na vestavěný primary agent "build" (plný edit/bash).
      agent: "build",
      // schema: additionalProperties:false, required:[parts] → JEN parts (žádný
      // top-level `text`, jinak 400 Unexpected property).
      parts: [{ type: "text", text: input.text }],
    }),
    signal: input.signal,
    dispatcher: workerDispatcher,
  } as FetchInit);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return parsePromptResponse({ info: { error: {
      name: "HTTPError", data: { statusCode: res.status, responseBody: t },
    } } });
  }
  const raw: unknown = await res.json().catch(() => {
    throw new OpencodePromptError("InvalidJSON");
  });
  return parsePromptResponse(raw);
}

/** Přeruší běžící session (překročen limit kroků / wall-clock). Best-effort. */
export async function abortSession(baseUrl: string, sessionId: string): Promise<void> {
  await postJson(ENDPOINTS.abort(baseUrl, sessionId), {}).catch(() => {
    /* při abortu nás chyba nezajímá */
  });
}

/**
 * SSE stream událostí session — async iterátor pro počítání kroků.
 * Parsuje `data:` řádky oddělené prázdným řádkem a yielduje rozparsované JSON eventy.
 */
export async function* subscribeEvents(
  baseUrl: string,
  signal?: AbortSignal,
): AsyncGenerator<OpencodeEvent> {
  const res = await fetch(ENDPOINTS.events(baseUrl), {
    headers: { Accept: "text/event-stream" },
    signal,
    dispatcher: workerDispatcher,
  } as FetchInit);
  if (!res.ok || !res.body) {
    throw new Error(`opencode /event selhalo: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          yield JSON.parse(dataLines.join("\n")) as OpencodeEvent;
        } catch {
          /* nekompletní/nevalidní JSON eventu ignorujeme */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Heuristika: vytáhne text finální odpovědi z různých tvarů odpovědi opencode. */
function extractText(raw: Record<string, unknown>): string {
  if (typeof raw.text === "string") return raw.text;
  const parts = raw.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  const message = raw.message as { content?: unknown } | undefined;
  if (message && typeof message.content === "string") return message.content;
  return "";
}
