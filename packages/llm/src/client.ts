import type { ModelName } from "./models.js";

/**
 * Část multimodálního obsahu (OpenAI-kompatibilní tvar). `content` zprávy může
 * být buď prostý string, nebo pole těchto částí (text + obrázky) — tak posíláme
 * screenshoty/vygenerované assety VLM modelu, aby je SKUTEČNĚ viděl.
 */
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Připojí obrázek (data: URL nebo veřejná URL) k poslední user zprávě jako multimodální content. */
export function attachImage(messages: ChatMessage[], imageUrl: string): ChatMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      out[i] = {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      };
      return out;
    }
  }
  return out;
}

/** Metadata pro atribuci nákladů (LiteLLM spend logs → cost_ledger). */
export interface CallMetadata {
  userId?: string;
  projectId?: string;
  taskId?: string;
  scope?: "task" | "attempt" | "media" | "system";
}

export interface ChatOptions {
  model: ModelName;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ephemeral per-attempt klíč; jinak master key. */
  apiKey?: string;
  metadata?: CallMetadata;
  /** Vynutit JSON objekt na výstupu. */
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** Whole-request deadline, including response-body keepalives; at most 3 minutes. */
  requestTimeoutMs?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  model: string;
}

function baseUrl(): string {
  return process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
}

function masterKey(): string {
  const k = process.env.LITELLM_MASTER_KEY;
  if (!k) throw new Error("LITELLM_MASTER_KEY není nastavena.");
  return k;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

/** A spending limit defers work; it is not evidence that the task failed. */
export function isLlmBudgetError(error: unknown): boolean {
  const value = error as { status?: number; message?: string; body?: string } | null;
  if (value?.status === 402) return true;
  const text = `${value?.message ?? String(error)} ${value?.body ?? ""}`;
  return /\b402\b|budget.{0,40}(exceed|exhaust|limit|unavailable|pause)|budget_exceeded/i.test(text);
}

/** Jedno volání chat completions přes LiteLLM proxy. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const timeoutMs = Math.min(opts.requestTimeoutMs ?? 180_000, 180_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid LLM request deadline");
  const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  body.max_tokens = opts.maxTokens ?? 4096;
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (opts.metadata) {
    body.metadata = {
      user_id: opts.metadata.userId,
      project_id: opts.metadata.projectId,
      task_id: opts.metadata.taskId,
      scope: opts.metadata.scope,
    };
  }

  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey ?? masterKey()}`,
    },
    body: JSON.stringify(body),
    // Providers can send whitespace while waiting for inference. An inactivity
    // timeout restarts on every keepalive; this deadline also covers res.json().
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`LLM request failed: ${res.status}`, res.status, text);
  }

  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    model?: string;
  };

  return {
    content: json.choices[0]?.message?.content ?? "",
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: json.model ?? opts.model,
  };
}

export interface StructuredResult<T> extends ChatResult {
  data: T;
}

/**
 * Strukturovaný výstup s validací a jedním retry.
 * `validate` vrátí true, nebo string s popisem chyby (ten se pošle modelu k opravě).
 */
export async function structured<T>(
  opts: ChatOptions & { validate: (data: unknown) => true | string },
): Promise<StructuredResult<T>> {
  const messages = [...opts.messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({ ...opts, messages, jsonMode: true });
    const parsed = tryParseJson(res.content);
    if (parsed !== undefined) {
      const ok = opts.validate(parsed);
      if (ok === true) return { ...res, data: parsed as T };
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: `Your JSON was invalid: ${ok}. Return corrected JSON only, no prose.`,
      });
    } else {
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: "That was not valid JSON. Return a single valid JSON object only.",
      });
    }
  }
  throw new LlmError("Structured output validation failed after retry.");
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // občas model obalí JSON textem — zkus vyseknout první {...}
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
