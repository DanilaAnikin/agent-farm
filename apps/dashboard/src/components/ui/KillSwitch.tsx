"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";

export type KillSwitchMode = "owner" | "auto" | "running";

/**
 * Nouzové zastavení farmy — dvě ODDĚLENÉ věci:
 *
 *  (a) ruční vypínač majitele (`owner_pause`) se stavy Zapnuto/Vypnuto. Jen ten
 *      se tu dá přepnout a je nadřazený všemu.
 *  (b) read-only řádek „Automatická pauza: …". Tu drží hlídače (drahé hodiny,
 *      došlý kredit, rozpočet) a ruční tlačítko ji NESMÍ přebít — pustí se sama.
 *
 * Dřív byl jeden velký „▶ Spustit", který se pral s off-peak plánovačem a
 * neřekl, kdo farmu drží ani kdy se sama rozjede.
 *
 * `initialPaused` = stav vypínače majitele (`owner_pause`), ne `global_pause`.
 * `detail` je starší alias pro `autoDetail` (admin stránka ho předává jako ReactNode).
 */
export function KillSwitch({
  initialPaused,
  onToggle,
  mode,
  autoDetail,
  detail,
  labelPaused = "Nouzové zastavení je zapnuté — farma nic nespustí, dokud ho nevypneš.",
  labelActive = "Nouzové zastavení je vypnuté — farma smí pracovat.",
}: {
  initialPaused: boolean;
  onToggle: (next: boolean) => Promise<{ ok: boolean; message?: string }>;
  /** Kdo farmu právě drží. Bez propu se odvodí jen z vypínače majitele. */
  mode?: KillSwitchMode;
  /** Popis automatické pauzy pro `mode === 'auto'` (typicky `farmState().detail`). */
  autoDetail?: ReactNode;
  /** Alias pro `autoDetail` — kdo pauzu drží a kdy se farma rozjede. */
  detail?: ReactNode;
  labelPaused?: string;
  labelActive?: string;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(initialPaused);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Po router.refresh() přijde nový prop — useState by jinak držel zastaralý stav.
  useEffect(() => {
    setPaused(initialPaused);
  }, [initialPaused]);

  const efektivniMode: KillSwitchMode = mode ?? (paused ? "owner" : "running");

  function toggle() {
    const next = !paused;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await onToggle(next);
      if (res.ok) {
        setPaused(next);
        // Např. „Vypínač majitele uvolněn, farmu ale drží automatická pauza…" —
        // bez zobrazení by to vypadalo, že se nic nestalo.
        if (res.message) setNotice(res.message);
        router.refresh();
      } else {
        setError(res.message ?? "Přepnutí selhalo.");
      }
    });
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-3">
        <button
          onClick={toggle}
          disabled={pending}
          aria-pressed={paused}
          aria-label={paused ? "Vypnout nouzové zastavení farmy" : "Zapnout nouzové zastavení farmy"}
          className={cn(
            "ring-focus relative flex h-28 w-28 items-center justify-center rounded-full border-4 text-center text-sm font-bold uppercase tracking-wide transition-all disabled:opacity-60",
            paused
              ? "border-[--color-ok] bg-[--color-ok-bg] text-[--color-ok] hover:brightness-125"
              : "border-[--color-danger] bg-[--color-danger-bg] text-[--color-danger] hover:brightness-125",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute inset-2 rounded-full border-2 border-dashed opacity-30",
              paused ? "border-[--color-ok]" : "border-[--color-danger]",
            )}
          />
          {paused ? "▶ Uvolnit" : "⏸ Zastavit vše"}
        </button>

        <div className="flex flex-col items-center gap-1.5 text-center">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[--color-muted]">Ruční vypínač</span>
            <Badge tone={paused ? "warn" : "neutral"} dot>
              {paused ? "Zapnuto" : "Vypnuto"}
            </Badge>
          </div>
          <p className="max-w-xs text-xs text-[--color-muted]">{paused ? labelPaused : labelActive}</p>
        </div>
      </div>

      {/* (b) automatická pauza — jen informace, nic se tu nepřepíná */}
      <div
        className={cn(
          "w-full max-w-sm rounded-[--radius-sm] border px-3 py-2 text-xs",
          efektivniMode === "auto"
            ? "border-[--color-info]/30 bg-[--color-info-bg] text-[--color-fg]"
            : "border-[--color-border-subtle] text-[--color-muted]",
        )}
      >
        <span className="font-medium">Automatická pauza: </span>
        {efektivniMode === "auto"
          ? (autoDetail ?? detail ?? "farmu drží hlídač — rozjede se sama.")
          : "žádná."}
      </div>

      {notice ? (
        <div role="status" className="max-w-sm text-center text-xs text-[--color-info]">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="max-w-sm text-center text-xs text-[--color-danger]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
