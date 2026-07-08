/**
 * fal.ai queue API klient — video klipy a obrázky.
 * Tok: submit → poll status → fetch response → download bytes.
 *
 * POZOR: model idčka jsou stav k červenci 2026 a jsou schválně schovaná za
 * malý router (video: Seedance workhorse / Hailuo b-roll / Kling hero;
 * image: Seedream volume / Nano-Banana pro text a konzistenci). Když se
 * providerská jména změní, mění se jen tato mapa.
 */
import { requireEnv } from "../env.js";

// --- Router modelů (červenec 2026) ------------------------------------------
export const FAL_MODELS = {
  video: {
    seedance: "fal-ai/bytedance/seedance-2.0", // default workhorse
    hailuoFast: "fal-ai/minimax/hailuo-2.3/fast", // levný b-roll
    kling: "fal-ai/kling-video/v3/pro/text-to-video", // hero záběry (dražší)
  },
  image: {
    seedream: "fal-ai/bytedance/seedream/v4/text-to-image", // volume
    nanoBanana: "fal-ai/nano-banana-2", // text v obraze, konzistence postav
  },
} as const;

// Odhad ceny $/sekunda videa (červenec 2026; do stropů je započítán retry buffer).
const VIDEO_USD_PER_S: Record<string, number> = {
  [FAL_MODELS.video.seedance]: 0.04, // ~$0.20 / 5s
  [FAL_MODELS.video.hailuoFast]: 0.02, // ~$0.10 / 5s
  [FAL_MODELS.video.kling]: 0.052, // ~$0.26 / 5s
};

// Odhad ceny za jeden obrázek.
const IMAGE_USD: Record<string, number> = {
  [FAL_MODELS.image.seedream]: 0.03,
  [FAL_MODELS.image.nanoBanana]: 0.06,
};

const FAL_QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 200; // ~10 min strop na jeden job

function apiKey(): string {
  return requireEnv("FAL_API_KEY", "Získej klíč na https://fal.ai (video/obrázky).");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface FalSubmitResponse {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatusResponse {
  status: string; // IN_QUEUE | IN_PROGRESS | COMPLETED | ...
  response_url?: string;
}

/** Odešle job do fal fronty a dopolluje výsledný JSON. */
async function runFalJob(model: string, input: Record<string, unknown>): Promise<unknown> {
  const key = apiKey();
  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => "");
    throw new Error(`fal.ai submit selhal (${submitRes.status}) pro ${model}: ${body}`);
  }
  const submit = (await submitRes.json()) as FalSubmitResponse;
  const statusUrl = submit.status_url ?? `${FAL_QUEUE_BASE}/${model}/requests/${submit.request_id}/status`;
  const responseUrl = submit.response_url ?? `${FAL_QUEUE_BASE}/${model}/requests/${submit.request_id}`;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await delay(POLL_INTERVAL_MS);
    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusRes.ok) {
      const body = await statusRes.text().catch(() => "");
      throw new Error(`fal.ai status selhal (${statusRes.status}) pro ${model}: ${body}`);
    }
    const status = (await statusRes.json()) as FalStatusResponse;
    if (status.status === "COMPLETED") {
      const resultRes = await fetch(status.response_url ?? responseUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!resultRes.ok) {
        const body = await resultRes.text().catch(() => "");
        throw new Error(`fal.ai výsledek selhal (${resultRes.status}) pro ${model}: ${body}`);
      }
      return await resultRes.json();
    }
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") {
      throw new Error(`fal.ai job skončil ve stavu ${status.status} pro ${model}.`);
    }
  }
  throw new Error(`fal.ai job nedoběhl v limitu pro ${model}.`);
}

/** Stáhne bytes z URL (výsledný soubor fal.ai). */
async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Stažení souboru z fal.ai selhalo (${res.status}): ${url}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Vytáhne první URL z různých tvarů fal odpovědi.
function extractUrl(result: unknown, keys: string[]): string | undefined {
  const r = result as Record<string, unknown>;
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as { url?: string }).url === "string") {
      return (v as { url: string }).url;
    }
    if (Array.isArray(v) && v[0]) {
      const first = v[0] as { url?: string } | string;
      if (typeof first === "string") return first;
      if (typeof first.url === "string") return first.url;
    }
  }
  return undefined;
}

export interface ClipRequest {
  prompt: string;
  durationS: number;
  model?: string;
  broll?: boolean;
  hero?: boolean;
}

export interface ProviderResult {
  bytes: Buffer;
  mime: string;
  costUsd: number;
  model: string;
  durationS?: number;
}

function pickVideoModel(req: ClipRequest): string {
  if (req.model) return req.model;
  if (req.hero) return FAL_MODELS.video.kling;
  if (req.broll) return FAL_MODELS.video.hailuoFast;
  return FAL_MODELS.video.seedance;
}

/** Deterministický odhad ceny klipu — čte ho i budget-gate PŘED voláním. */
export function estimateClipCostUsd(req: ClipRequest): number {
  const model = pickVideoModel(req);
  const perS = VIDEO_USD_PER_S[model] ?? 0.05;
  return Number((perS * Math.max(1, req.durationS)).toFixed(4));
}

/** Vygeneruje video klip a stáhne jeho bytes. */
export async function generateClip(req: ClipRequest): Promise<ProviderResult> {
  const model = pickVideoModel(req);
  const result = await runFalJob(model, {
    prompt: req.prompt,
    duration: Math.round(req.durationS),
    aspect_ratio: "9:16",
    resolution: "1080p",
  });
  const url = extractUrl(result, ["video", "videos", "output", "url"]);
  if (!url) {
    throw new Error(`fal.ai nevrátil URL videa pro model ${model}.`);
  }
  const bytes = await downloadBytes(url);
  return {
    bytes,
    mime: "video/mp4",
    costUsd: estimateClipCostUsd(req),
    model,
    durationS: req.durationS,
  };
}

export interface ImageRequest {
  prompt: string;
  model?: string;
}

function pickImageModel(req: ImageRequest): string {
  return req.model ?? FAL_MODELS.image.seedream;
}

/** Deterministický odhad ceny obrázku — čte ho i budget-gate PŘED voláním. */
export function estimateImageCostUsd(req: ImageRequest): number {
  const model = pickImageModel(req);
  return IMAGE_USD[model] ?? 0.05;
}

/** Vygeneruje statický obrázek a stáhne jeho bytes. */
export async function generateImage(req: ImageRequest): Promise<ProviderResult> {
  const model = pickImageModel(req);
  const result = await runFalJob(model, {
    prompt: req.prompt,
    image_size: "portrait_16_9",
    num_images: 1,
  });
  const url = extractUrl(result, ["images", "image", "output", "url"]);
  if (!url) {
    throw new Error(`fal.ai nevrátil URL obrázku pro model ${model}.`);
  }
  const bytes = await downloadBytes(url);
  return {
    bytes,
    mime: "image/png",
    costUsd: estimateImageCostUsd(req),
    model,
  };
}
