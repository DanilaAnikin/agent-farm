"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideApproval } from "@/app/actions/approvals";
import { Button } from "@/components/ui/Button";

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function decide(decision: "approved" | "rejected") {
    startTransition(async () => {
      await decideApproval(approvalId, decision);
      router.refresh();
    });
  }

  return (
    <div className="flex gap-2">
      <Button variant="success" size="sm" loading={pending} onClick={() => decide("approved")}>
        Schválit
      </Button>
      <Button variant="danger" size="sm" loading={pending} onClick={() => decide("rejected")}>
        Zamítnout
      </Button>
    </div>
  );
}
