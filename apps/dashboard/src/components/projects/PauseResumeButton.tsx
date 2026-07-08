"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setProjectStatus } from "@/app/actions/projects";
import { Button } from "@/components/ui/Button";
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
  const isPaused = status === "paused" || status === "stopped";
  const target: ProjectStatus = isPaused ? "active" : "paused";

  return (
    <Button
      size={size}
      variant={isPaused ? "success" : "secondary"}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          await setProjectStatus(projectId, target);
          router.refresh();
        })
      }
    >
      {isPaused ? "▶ Spustit" : "⏸ Pozastavit"}
    </Button>
  );
}
