/**
 * Voiceover router: nejdřív lokální Kokoro (zdarma, když je nakonfigurované),
 * pak Fish Audio, nakonec ElevenLabs jako placený fallback.
 */
import { optionalEnv } from "../env.js";
import { estimateTtsCostUsd, ttsElevenLabs, type TtsRequest } from "./elevenlabs.js";
import type { ProviderResult } from "./fal.js";

const FISH_BASE = "https://api.fish.audio/v1";

/**
 * Vrátí odhad ceny voiceoveru. Kokoro = zdarma (self-host), jinak délka textu.
 * Budget-gate to čte PŘED voláním, takže výběr providera musí být deterministický.
 */
export function estimateVoiceoverCostUsd(req: TtsRequest): number {
  if (optionalEnv("KOKORO_URL")) return 0; // lokální self-host
  return estimateTtsCostUsd(req);
}

/** Kokoro (OpenAI-kompatibilní /v1/audio/speech). */
async function ttsKokoro(kokoroUrl: string, req: TtsRequest): Promise<ProviderResult> {
  const res = await fetch(`${kokoroUrl.replace(/\/$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: req.text,
      voice: req.voice ?? "af_heart",
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kokoro TTS selhal (${res.status}): ${body}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: "audio/mpeg", costUsd: 0, model: "kokoro" };
}

/** Fish Audio TTS. */
async function ttsFish(apiKey: string, req: TtsRequest): Promise<ProviderResult> {
  const res = await fetch(`${FISH_BASE}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: req.text,
      format: "mp3",
      ...(req.voice ? { reference_id: req.voice } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fish Audio TTS selhal (${res.status}): ${body}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: "audio/mpeg", costUsd: estimateTtsCostUsd(req), model: "fish-audio" };
}

/**
 * Vygeneruje voiceover. Vybere providera deterministicky podle env:
 * Kokoro → Fish → ElevenLabs. Když není nakonfigurovaný žádný, selže česky.
 */
export async function generateVoiceover(req: TtsRequest): Promise<ProviderResult> {
  const kokoroUrl = optionalEnv("KOKORO_URL");
  if (kokoroUrl) return ttsKokoro(kokoroUrl, req);

  const fishKey = optionalEnv("FISH_AUDIO_API_KEY");
  if (fishKey) return ttsFish(fishKey, req);

  if (optionalEnv("ELEVENLABS_API_KEY")) return ttsElevenLabs(req);

  throw new Error(
    "Není nakonfigurovaný žádný TTS provider. Nastav KOKORO_URL, FISH_AUDIO_API_KEY nebo ELEVENLABS_API_KEY.",
  );
}
