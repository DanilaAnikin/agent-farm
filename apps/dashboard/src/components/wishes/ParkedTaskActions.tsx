"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelTask, retryTask } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";

// Retry zaparkovaného tasku s poznámkou / zrušení.
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
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-3 space-y-2">
      {open ? (
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Poznámka k dalšímu pokusu (injektuje se do promptu)…"
          className="min-h-16 text-xs"
        />
      ) : null}
      <div className="flex gap-2">
        {open ? (
          <Button
            size="sm"
            variant="success"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                await retryTask({ taskId, projectId, wishId, note });
                setOpen(false);
                setNote("");
                router.refresh();
              })
            }
          >
            Znovu spustit
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Retry s poznámkou
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              await cancelTask({ taskId, projectId, wishId });
              router.refresh();
            })
          }
        >
          Zrušit úkol
        </Button>
      </div>
    </div>
  );
}
