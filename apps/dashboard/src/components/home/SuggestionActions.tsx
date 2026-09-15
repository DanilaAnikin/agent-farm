"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { convertSuggestionToWish } from "@/app/actions/suggestions";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";

export interface SuggestionTargetProject {
  id: string;
  name: string;
  status: string;
}

/**
 * Jediná ruční korekce u rozhodnutí farmy: návrh bez cílového projektu
 * („napříč projekty") farma zadat nemůže, člověk mu projekt doplní.
 * Schvalovací tlačítka Přijmout/Zahodit zmizela — o návrzích rozhoduje farma.
 */
export function SuggestionActions({
  suggestionId,
  projects,
}: {
  suggestionId: string;
  projects: SuggestionTargetProject[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const aktivni = projects.filter((p) => p.status === "active");
  const [target, setTarget] = useState<string>(aktivni[0]?.id ?? projects[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (projects.length === 0) return null;

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Zadat do projektu…
      </Button>
    );
  }

  const vybrany = projects.find((p) => p.id === target);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Cílový projekt"
          className="ring-focus h-8 rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface-2) px-2 text-xs text-(--color-fg) focus:outline-none"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.status === "budget_hold" ? " (čeká na rozpočet)" : p.status !== "active" ? " (pozastaveno)" : ""}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Zpět
        </Button>
        <Button
          size="sm"
          loading={pending}
          disabled={!target}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await convertSuggestionToWish(suggestionId, target);
              if (!res.ok) {
                setError(res.message ?? "Zadání se nepodařilo.");
                return;
              }
              if (res.link) router.push(res.link);
              router.refresh();
            });
          }}
        >
          Zadat
        </Button>
      </div>
      {vybrany && vybrany.status !== "active" ? (
        <span className="text-[11px] text-(--color-muted)">Projekt je pozastavený — přání počká.</span>
      ) : null}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}
