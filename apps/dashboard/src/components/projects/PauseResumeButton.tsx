"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play } from "lucide-react";
import { setProjectStatus } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import type { ProjectStatus } from "@/lib/types";

export function PauseResumeButton({
  projectId,
  status,
  size = "md",
}: {
  projectId: string;
  status: ProjectStatus;
  size?: "sm" | "md" | "lg";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isPaused = status === "paused" || status === "stopped";
  const target: ProjectStatus = isPaused ? "active" : "paused";

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size={size}
        variant={isPaused ? "success" : "secondary"}
        loading={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const res = await setProjectStatus(projectId, target);
            if (!res.ok) {
              // Bez zpětné vazby by neúspěšná pauza vypadala jako úspěch — uživatel by
              // si myslel, že drahý projekt zastavil, zatímco agenti dál pálí rozpočet.
              setError(res.message ?? "Změna stavu se nepodařila.");
              return;
            }
            router.refresh();
          });
        }}
      >
        {isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
        {isPaused ? "Spustit" : "Pozastavit"}
      </Button>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}
