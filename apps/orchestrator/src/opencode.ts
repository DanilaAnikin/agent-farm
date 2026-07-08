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

const ENDPOINTS = {
  createSession: (base: string) => `${base}/session`,
  message: (base: string, sessionId: string) => `${base}/session/${sessionId}/message`,
  events: (base: string) => `${base}/event`,
  abort: (base: string, sessionId: string) => `${base}/session/${sessionId}/abort`,
} as const;

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
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`opencode ${url} selhalo: ${res.status} ${t}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

/** Vytvoří novou session (fresh kontext na jeden pokus). */
export async function createSession(baseUrl: string, signal?: AbortSignal): Promise<OpencodeSession> {
  const json = await postJson<{ id?: string; sessionID?: string }>(
    ENDPOINTS.createSession(baseUrl),
    {},
    signal,
  );
  const id = json.id ?? json.sessionID;
  if (!id) throw new Error("opencode createSession nevrátil id session.");
  return { id };
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
      agent: input.agent,
      model: input.model,
      // opencode přijímá buď `text`, nebo `parts` — posíláme text jako jednu část.
      parts: [{ type: "text", text: input.text }],
      text: input.text,
    }),
    signal: input.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`opencode prompt selhalo: ${res.status} ${t}`);
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { text: extractText(raw), raw };
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
  });
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
