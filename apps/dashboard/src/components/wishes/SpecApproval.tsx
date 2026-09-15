"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveSpec, rejectSpec } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import type { AcceptanceCriterion, WishStatus } from "@/lib/types";

/** Přání, u kterých už specifikace platí (práce běží nebo skončila). */
const ZA_SPECIFIKACI: WishStatus[] = ["active", "done", "parked"];

/**
 * Specifikace přání.
 *
 * V autopilotu (projects.trust_mode) je to JEN zobrazení: specifikaci schvaluje
 * farma sama, blokující „Schválit a spustit" tu nemá co dělat. Když chybí
 * `approved_at`, ale přání už běží, bylo schváleno automaticky. Jediná ruční
 * akce je „Požádat o novou verzi" — a jen dokud je spec ve fázi schvalování,
 * protože z běžícího přání stavový automat zpět do `new` nevede.
 *
 * Starší projekty bez autopilotu mají původní schvalovací formulář.
 */
export function SpecApproval({
  wishId,
  specId,
  projectId,
  content,
  criteria,
  approvedAt,
  editable,
  autopilot,
  wishStatus,
}: {
  wishId: string;
  specId: string;
  projectId: string;
  content: string;
  criteria: AcceptanceCriterion[];
  approvedAt: string | null;
  editable: boolean;
  autopilot: boolean;
  wishStatus: WishStatus;
}) {
  const router = useRouter();
  const [edited, setEdited] = useState(content);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const rucniSchvaleni = editable && !autopilot && !approvedAt;
  const lzeZadatNovouVerzi = wishStatus === "awaiting_spec_approval";

  function doApprove() {
    setError(null);
    startTransition(async () => {
      const res = await approveSpec({ wishId, specId, projectId, editedContent: edited });
      if (!res.ok) setError(res.message ?? "Schválení selhalo.");
      else router.refresh();
    });
  }

  function doReject() {
    setError(null);
    startTransition(async () => {
      const res = await rejectSpec({ wishId, projectId });
      if (!res.ok) setError(res.message ?? "Žádost o novou verzi selhala.");
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {approvedAt ? (
        <Badge tone="ok" dot>
          Schváleno
        </Badge>
      ) : ZA_SPECIFIKACI.includes(wishStatus) ? (
        <Badge tone="ok" dot>
          Schváleno automaticky
        </Badge>
      ) : autopilot ? (
        <Badge tone="info" dot>
          Schválí se automaticky
        </Badge>
      ) : rucniSchvaleni ? (
        <Badge tone="warn" dot>
          Čeká na schválení (projekt bez autopilotu)
        </Badge>
      ) : (
        <Badge tone="info">Návrh</Badge>
      )}

      {rucniSchvaleni ? (
        <Textarea
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          className="min-h-64 font-mono text-xs"
        />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-(--color-border) bg-(--color-surface-2) p-4 text-xs text-(--color-fg)">
          {content}
        </pre>
      )}

      {criteria.length > 0 ? (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-muted)">
            Akceptační kritéria
          </h4>
          <ul className="space-y-1.5">
            {criteria.map((c) => (
              <li key={c.id} className="flex gap-2 text-sm">
                <span className="text-(--color-accent)">◦</span>
                <span>
                  {c.description}
                  {c.check ? (
                    <code className="ml-2 rounded bg-(--color-surface-2) px-1.5 py-0.5 text-xs text-(--color-muted)">
                      {c.check}
                    </code>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-xs text-(--color-danger)">{error}</p> : null}

      {rucniSchvaleni ? (
        <div className="flex gap-2">
          <Button variant="success" loading={pending} onClick={doApprove}>
            Schválit a spustit
          </Button>
          <Button variant="secondary" loading={pending} onClick={doReject}>
            Požádat o novou verzi
          </Button>
        </div>
      ) : lzeZadatNovouVerzi && !approvedAt ? (
        <Button size="sm" variant="ghost" loading={pending} onClick={doReject}>
          Požádat o novou verzi
        </Button>
      ) : null}
    </div>
  );
}
