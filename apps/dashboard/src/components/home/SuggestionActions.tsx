"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptSuggestion, dismissSuggestion } from "@/app/actions/suggestions";
import { Button } from "@/components/ui/Button";

/**
 * Přijmout / Zahodit návrh farmy. Přijetí projektového návrhu založí přání;
 * návrh napříč projekty se jen označí jako přijatý (zadáš ho do konkrétního
 * projektu ručně).
 */
export function SuggestionActions({
  suggestionId,
  crossProject = false,
}: {
  suggestionId: string;
  crossProject?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(kind: "accept" | "dismiss") {
    setError(null);
    startTransition(async () => {
      const res =
        kind === "accept"
          ? await acceptSuggestion(suggestionId)
          : await dismissSuggestion(suggestionId);
      if (!res.ok) {
        setError(res.message ?? "Akce selhala.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() => decide("dismiss")}
        >
          Zahodit
        </Button>
        <Button size="sm" loading={pending} onClick={() => decide("accept")}>
          {crossProject ? "Přijmout" : "Přijmout → přání"}
        </Button>
      </div>
      {error ? <span className="text-xs text-[--color-danger]">{error}</span> : null}
    </div>
  );
}
