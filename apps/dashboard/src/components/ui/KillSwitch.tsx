"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * Velký červený přepínač PAUSE/RESUME. Generický — dostane aktuální stav a akci.
 * Používá se pro globální kill switch (admin), případně jinde.
 */
export function KillSwitch({
  initialPaused,
  onToggle,
  labelPaused = "Farma pozastavena",
  labelActive = "Farma běží",
}: {
  initialPaused: boolean;
  onToggle: (next: boolean) => Promise<{ ok: boolean; message?: string }>;
  labelPaused?: string;
  labelActive?: string;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(initialPaused);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !paused;
    setError(null);
    startTransition(async () => {
      const res = await onToggle(next);
      if (res.ok) {
        setPaused(next);
        router.refresh();
      } else {
        setError(res.message ?? "Přepnutí selhalo.");
      }
    });
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={toggle}
        disabled={pending}
        className={cn(
          "relative flex h-28 w-28 items-center justify-center rounded-full border-4 text-center text-sm font-bold uppercase tracking-wide transition-all disabled:opacity-60",
          paused
            ? "border-[--color-ok] bg-[--color-ok-bg] text-[--color-ok] hover:brightness-125"
            : "border-[--color-danger] bg-[--color-danger-bg] text-[--color-danger] hover:brightness-125",
        )}
      >
        <span className={cn("absolute inset-2 rounded-full border-2 border-dashed opacity-30", paused ? "border-[--color-ok]" : "border-[--color-danger]")} />
        {paused ? "▶ Spustit" : "⏸ Zastavit vše"}
      </button>
      <div className="text-center">
        <div className={cn("text-sm font-medium", paused ? "text-[--color-warn]" : "text-[--color-ok]")}>
          {paused ? labelPaused : labelActive}
        </div>
        {error ? <div className="mt-1 text-xs text-[--color-danger]">{error}</div> : null}
      </div>
    </div>
  );
}
