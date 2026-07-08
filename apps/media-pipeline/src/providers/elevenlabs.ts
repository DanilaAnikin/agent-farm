/**
 * ElevenLabs — hudba (Music API) a fallback TTS.
 * Licencovaná trénovací data → čistá komerční práva pro publikaci.
 */
import { requireEnv } from "../env.js";
import type { ProviderResult } from "./fal.js";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

// Odhad ceny (červenec 2026): hudba ~$0.15/min; TTS je fallback, ~$15/1M znaků.
const MUSIC_USD_PER_MIN = 0.15;
const TTS_USD_PER_CHAR = 15 / 1_000_000;

// Výchozí hlas (fallback TTS). Přepsatelný přes env.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2";

function apiKey(): string {
  return requireEnv("ELEVENLABS_API_KEY", "Získej klíč na https://elevenlabs.io (hudba, TTS fallback).");
}

export interface MusicRequest {
  prompt: string;
  durationS: number;
}

/** Deterministický odhad ceny hudby — čte ho i budget-gate PŘED voláním. */
export function estimateMusicCostUsd(req: MusicRequest): number {
  return Number(((req.durationS / 60) * MUSIC_USD_PER_MIN).toFixed(4));
}

/** Vygeneruje hudební podkres (mp3). */
export async function generateMusic(req: MusicRequest): Promise<ProviderResult> {
  const res = await fetch(`${ELEVEN_BASE}/music`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: req.prompt,
      music_length_ms: Math.round(req.durationS * 1000),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs Music selhal (${res.status}): ${body}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    mime: "audio/mpeg",
    costUsd: estimateMusicCostUsd(req),
    model: "elevenlabs-music",
    durationS: req.durationS,
  };
}

export interface TtsRequest {
  text: string;
  voice?: string;
}

/** Deterministický odhad ceny TTS. */
export function estimateTtsCostUsd(req: TtsRequest): number {
  return Number((req.text.length * TTS_USD_PER_CHAR).toFixed(4));
}

/** Fallback voiceover přes ElevenLabs TTS (mp3). */
export async function ttsElevenLabs(req: TtsRequest): Promise<ProviderResult> {
  const voiceId = req.voice ?? DEFAULT_VOICE_ID;
  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: req.text,
      model_id: DEFAULT_TTS_MODEL,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS selhal (${res.status}): ${body}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    mime: "audio/mpeg",
    costUsd: estimateTtsCostUsd(req),
    model: "elevenlabs-tts",
  };
}
