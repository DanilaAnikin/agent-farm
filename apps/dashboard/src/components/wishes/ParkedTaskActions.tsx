"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelTask, retryTask } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";

// Ruční zásah u zaparkovaného úkolu: nový pokus s poznámkou, nebo zrušení
// (úkol zůstane zaparkovaný s důvodem „zrušeno majitelem").
export function ParkedTaskActions({
  taskId,
  projectId,
  wishId,
}: {
  taskId: string;
  projectId: string;
  wishId: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Oddělené pending stavy — dřív jeden `pending` točil OBĚ tlačítka najednou.
  const [retryPending, startRetry] = useTransition();
  const [cancelPending, startCancel] = useTransition();

  function doRetry() {
    setError(null);
    startRetry(async () => {
      const res = await retryTask({ taskId, projectId, wishId, note });
      if (!res.ok) {
        setError(res.message ?? "Opětovné spuštění se nepodařilo.");
        return;
      }
      setOpen(false);
      setNote("");
      router.refresh();
    });
  }

  function doCancel() {
    setError(null);
    startCancel(async () => {
      const res = await cancelTask({ taskId, projectId, wishId });
      if (!res.ok) {
        setError(res.message ?? "Zrušení úkolu se nepodařilo.");
        setConfirmingCancel(false);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-2">
      {open ? (
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Poznámka k dalšímu pokusu (dostane ji agent v zadání)…"
          className="min-h-16 text-xs"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          <Button size="sm" variant="success" loading={retryPending} onClick={doRetry}>
            Znovu spustit
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Zkusit znovu s poznámkou
          </Button>
        )}

        {/* Zrušení je NEVRATNÉ → dvoukrokové potvrzení (ochrana proti překliku). */}
        {confirmingCancel ? (
          <>
            <Button size="sm" variant="danger" loading={cancelPending} onClick={doCancel}>
              Opravdu zrušit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={cancelPending}
              onClick={() => setConfirmingCancel(false)}
            >
              Zpět
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingCancel(true)}>
            Zrušit úkol
          </Button>
        )}
      </div>
      {confirmingCancel ? (
        <p className="text-xs text-[--color-muted]">
          Úkol zůstane zaparkovaný jako zrušený majitelem a farma ho sama znovu nespustí.
        </p>
      ) : null}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}
