"use client";

import { useRef, useState } from "react";
import { useSupabase } from "@/lib/supabase/provider";
import { createVoiceWish } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";

/**
 * Nahraje hlas přes MediaRecorder → upload do Storage bucketu 'media' →
 * založí wish source='voice' + event type='voice_wish' (orchestrátor přepíše).
 */
export function VoiceRecorder({
  projectId,
  userId,
  onCreated,
}: {
  projectId: string;
  userId: string;
  onCreated?: (wishId: string) => void;
}) {
  const supabase = useSupabase();
  const [state, setState] = useState<"idle" | "recording" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void upload(new Blob(chunksRef.current, { type: "audio/webm" }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setState("recording");
    } catch {
      setState("error");
      setMessage("Nepodařilo se získat mikrofon (povol přístup v prohlížeči).");
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setState("uploading");
  }

  async function upload(blob: Blob) {
    try {
      const path = `users/${userId}/projects/${projectId}/voice/${crypto.randomUUID()}.webm`;
      const { error } = await supabase.storage.from("media").upload(path, blob, {
        contentType: "audio/webm",
        upsert: false,
      });
      if (error) throw error;

      const res = await createVoiceWish({ projectId, storagePath: path });
      if (!res.ok) throw new Error(res.message);
      setState("done");
      setMessage("Hlasové přání nahráno — orchestrátor ho přepíše.");
      if (res.id) onCreated?.(res.id);
    } catch (err) {
      setState("error");
      setMessage("Nahrání selhalo: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface-2) p-4">
      <div className="flex items-center gap-3">
        {state === "recording" ? (
          <Button variant="danger" size="sm" onClick={stop} type="button">
            ⏹ Zastavit nahrávání
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={start}
            type="button"
            loading={state === "uploading"}
            disabled={state === "uploading"}
          >
            🎤 Namluvit přání
          </Button>
        )}
        {state === "recording" ? (
          <span className="flex items-center gap-2 text-sm text-(--color-danger)">
            <span className="h-2 w-2 rounded-full bg-(--color-danger) animate-farm-pulse" />
            Nahrávám…
          </span>
        ) : null}
      </div>
      {message ? (
        <p
          role={state === "error" ? "alert" : "status"}
          aria-live={state === "error" ? "assertive" : "polite"}
          className={"mt-2 text-xs " + (state === "error" ? "text-(--color-danger)" : "text-(--color-ok)")}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
