"use client";

import { useState, useTransition } from "react";
import { updateManagerNote } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";

// Poznámka manažerovi — vstupuje do příštího refill promptu (priorita č. 1).
export function ManagerNote({
  projectId,
  initialNote,
}: {
  projectId: string;
  initialNote: string | null;
}) {
  const [note, setNote] = useState(initialNote ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      <Textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSaved(false);
          setError(null);
        }}
        placeholder="Např. „teď se soustřeď na výkon, přestaň refactorovat, přidávej featury"
        className="min-h-20"
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await updateManagerNote(projectId, note);
              // Dřív se ošetřoval jen success — selhání vypadalo jako by se nic nestalo.
              if (res.ok) setSaved(true);
              else setError(res.message ?? "Uložení se nepodařilo.");
            })
          }
        >
          Uložit poznámku
        </Button>
        {saved ? (
          <FormMessage tone="success">Uloženo — projeví se v dalším kole.</FormMessage>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>
    </div>
  );
}
