/**
 * STT servis (OVERVIEW §5.2). Dashboard/Telegram nahrají audio přání do Storage a
 * zapíšou event type='voice_wish' se `wish_id` (sloupec) a `data.storagePath`.
 * Orchestrátor audio stáhne, přepíše přes Groq Whisper (jediná ne-čínská výjimka —
 * teče tam jen audio) a přepis zapíše do wish.description. GROQ_API_KEY drží jen
 * orchestrátor.
 *
 * Konvence: hotové přepisy značíme eventem `stt_done` pro tentýž wishId
 * (append-only tabulka events — proto porovnáváme requesty vs. done).
 */
import { getSql, getDb, wishes } from "@farm/db";
import { eq } from "drizzle-orm";
import { createStorage } from "@farm/storage";
import { logEvent } from "./events.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

interface SttRequest {
  wishId: string;
  audioPath: string;
}

/** Jedna iterace STT loopu — zpracuje nevyřízené požadavky na přepis. */
export async function runSttOnce(): Promise<void> {
  const pending = await pendingSttRequests();
  if (pending.length === 0) return;

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    // Bez klíče přepis neuděláme — ale NESMÍ to tiše viset navždy. Uživateli to
    // jednou nahlásíme (event + srozumitelný popis přání), ať ví, co se děje.
    console.error("[stt] GROQ_API_KEY není nastavena — hlasová přání nelze přepsat.");
    for (const req of pending) {
      await getDb()
        .update(wishes)
        .set({
          description:
            "🎤⚠️ Hlasové přání se nepodařilo přepsat: přepis řeči (GROQ_API_KEY) není nakonfigurovaný. " +
            "Zadej přání prosím textem.",
        })
        .where(eq(wishes.id, req.wishId));
      await logEvent({
        wishId: req.wishId,
        level: "warn",
        type: "stt_unconfigured",
        message: "Hlasové přání nelze přepsat — STT (GROQ_API_KEY) není nastavené. Zadej přání textem.",
      });
    }
    return;
  }

  const storage = createStorage();
  for (const req of pending) {
    try {
      const audio = await storage.get(req.audioPath);
      const transcript = await transcribe(audio, req.audioPath, key);

      await getDb()
        .update(wishes)
        .set({ description: transcript })
        .where(eq(wishes.id, req.wishId));

      await logEvent({
        wishId: req.wishId,
        type: "stt_done",
        message: "Hlasové přání přepsáno.",
        data: { chars: transcript.length },
      });
    } catch (err) {
      console.error(`[stt] přepis wish ${req.wishId} selhal:`, err);
      await logEvent({
        wishId: req.wishId,
        level: "error",
        type: "stt_error",
        message: `Přepis selhal: ${String(err)}`,
      });
    }
  }
}

/** Požadavky `voice_wish` bez odpovídajícího `stt_done` (posledních 24 h). */
async function pendingSttRequests(): Promise<SttRequest[]> {
  const rows = await getSql()<{ wish_id: string; audio_path: string }[]>`
    SELECT DISTINCT req.wish_id::text AS wish_id, (req.data->>'storagePath') AS audio_path
    FROM events req
    WHERE req.type = 'voice_wish'
      AND req.ts >= now() - interval '24 hours'
      AND req.wish_id IS NOT NULL
      AND req.data->>'storagePath' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events done
        WHERE done.type IN ('stt_done', 'stt_unconfigured')
          AND done.wish_id = req.wish_id
      )
  `;
  return rows.map((r) => ({ wishId: r.wish_id, audioPath: r.audio_path }));
}

/** Multipart POST na Groq Whisper. Vrací přepsaný text. */
async function transcribe(audio: Buffer, path: string, apiKey: string): Promise<string> {
  const form = new FormData();
  const filename = path.split("/").pop() ?? "audio.webm";
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", GROQ_MODEL);
  form.append("response_format", "json");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Groq Whisper selhal: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
