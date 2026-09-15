"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * Velký červený přepínač PAUSE/RESUME. Generický — dostane aktuální stav a akci.
 * Používá se pro nouzové zastavení farmy (admin), případně jinde.
 *
 * `initialPaused` je stav TOHO, CO TLAČÍTKO PŘEPÍNÁ (vypínač majitele), ne stav
 * celé farmy. Farma může stát i s uvolněným vypínačem (automatická pauza) —
 * to říká `mode` a popisek, aby tlačítko „Spustit" nesvítilo, když ho nejde použít.
 */
export function KillSwitch({
  initialPaused,
  onToggle,
  labelPaused = "Farma pozastavena",
  labelActive = "Farma běží",
  mode,
  detail,
}: {
  initialPaused: boolean;
  onToggle: (next: boolean) => Promise<{ ok: boolean; message?: string }>;
  labelPaused?: string;
  labelActive?: string;
  /** running = běží; owner = drží vypínač; auto = stojí na automatické pauze. */
  mode?: "running" | "owner" | "auto";
  /** Kdo pauzu drží a kdy se farma rozjede. */
  detail?: ReactNode;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(initialPaused);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Po router.refresh() přijde čerstvý stav ze serveru — useState by ho jinak ignoroval.
  useEffect(() => setPaused(initialPaused), [initialPaused]);

  function toggle() {
    const next = !paused;
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await onToggle(next);
      if (res.ok) {
        setPaused(next);
        // Hláška serveru se MUSÍ ukázat: „spustit" může uvolnit jen vypínač
        // majitele, zatímco farmu dál drží automatická pauza.
        setInfo(res.message ?? null);
        router.refresh();
      } else {
        setError(res.message ?? "Přepnutí selhalo.");
      }
    });
  }

  const labelTone =
    paused || mode === "owner"
      ? "text-[--color-warn]"
      : mode === "auto"
        ? "text-[--color-info]"
        : "text-[--color-ok]";

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
      <div className="max-w-xs text-center">
        <div className={cn("text-sm font-medium", labelTone)}>{paused ? labelPaused : labelActive}</div>
        {detail ? <div className="mt-1 text-xs text-[--color-muted]">{detail}</div> : null}
        {info ? (
          <div role="status" aria-live="polite" className="mt-2 text-xs text-[--color-fg]">
            {info}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="mt-1 text-xs text-[--color-danger]">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
