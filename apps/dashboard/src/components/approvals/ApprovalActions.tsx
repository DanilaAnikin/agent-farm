"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideApproval } from "@/app/actions/approvals";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Který tlačítko běží — aby spinner ukázalo JEN klikané (dřív jeden `pending` točil obě).
  const [active, setActive] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "approved" | "rejected") {
    setError(null);
    setActive(decision);
    startTransition(async () => {
      const res = await decideApproval(approvalId, decision);
      if (!res.ok) {
        // Kritická nevratná akce — uživatel MUSÍ vědět, že se rozhodnutí nezapsalo
        // (např. race s Telegramem/auto-deliverem nebo expirace).
        setError(res.message ?? "Rozhodnutí se nepodařilo uložit.");
        setActive(null);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <Button
          variant="success"
          size="sm"
          loading={pending && active === "approved"}
          disabled={pending}
          onClick={() => decide("approved")}
        >
          Schválit
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={pending && active === "rejected"}
          disabled={pending}
          onClick={() => decide("rejected")}
        >
          Zamítnout
        </Button>
      </div>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}
