"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { deployProject } from "@/app/actions/deploy";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";

export function PushToProductionButton({
  projectId,
  size = "md",
  lastStatus,
}: {
  projectId: string;
  size?: "sm" | "md" | "lg";
  /** Stav posledního deploye (z deploy_requests) — pending/running/done/failed. */
  lastStatus?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const inFlight = lastStatus === "pending" || lastStatus === "running";

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size={size}
        variant="secondary"
        loading={pending || inFlight}
        onClick={() => {
          setMsg(null);
          startTransition(async () => {
            const res = await deployProject(projectId);
            setMsg({ tone: res.ok ? "success" : "error", text: res.message ?? (res.ok ? "Zařazeno." : "Chyba.") });
            if (res.ok) router.refresh();
          });
        }}
      >
        <Rocket className="size-4" />
        {inFlight ? "Nasazuji…" : "Push to Production"}
      </Button>
      {msg ? (
        <FormMessage tone={msg.tone}>{msg.text}</FormMessage>
      ) : lastStatus === "done" ? (
        <FormMessage tone="success">✓ up-to-date na produkci</FormMessage>
      ) : lastStatus === "failed" ? (
        <FormMessage tone="error">Poslední deploy selhal — mrkni do událostí.</FormMessage>
      ) : null}
    </div>
  );
}
