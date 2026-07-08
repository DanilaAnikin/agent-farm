"use client";

import { useState, useTransition } from "react";
import { updateManagerNote } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";

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
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      <Textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSaved(false);
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
              const res = await updateManagerNote(projectId, note);
              if (res.ok) setSaved(true);
            })
          }
        >
          Uložit poznámku
        </Button>
        {saved ? <span className="text-xs text-[--color-ok]">Uloženo — projeví se v dalším kole.</span> : null}
      </div>
    </div>
  );
}
