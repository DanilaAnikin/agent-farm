"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";

/**
 * SIGNATURE „living telemetry" prvky — jedna vlastnitelná mechanika putujícího
 * světla po žíle. Nahrazuje ručně kopírované busy indikátory. Puls/lifeline JEN
 * na aktivním prvku (to jim dává význam).
 */

/** Vertikální lifeline — vlož jako absolutní prvek do left-0 běžícího kontejneru
 *  (rodič musí být `relative`). Nebo použij utilitu `.lifeline` přímo na kontejner. */
export function Lifeline({ className }: { className?: string }) {
  return <span aria-hidden className={cn("lifeline pointer-events-none absolute inset-y-0 left-0 w-0.5", className)} />;
}

/** Horizontální data-bus — tep celé farmy (např. pod topbarem shellu). */
export function DataBus({ className }: { className?: string }) {
  return <div aria-hidden className={cn("data-bus w-full", className)} />;
}

/** Dýchající status tečka — „něco žije". `tone` řídí barvu; puls jen pro running. */
export function StatusPulse({
  tone = "brand",
  pulse = true,
  className,
}: {
  tone?: "brand" | "info" | "warn" | "danger" | "muted";
  pulse?: boolean;
  className?: string;
}) {
  const color =
    tone === "info"
      ? "bg-(--color-info)"
      : tone === "warn"
        ? "bg-(--color-warn)"
        : tone === "danger"
          ? "bg-(--color-danger)"
          : tone === "muted"
            ? "bg-(--color-faint)"
            : "bg-(--color-brand)";
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color, pulse && "status-pulse", className)}
    />
  );
}

/**
 * Pravdivý štítek živosti. „živě" (s dýchající tečkou) JEN když je realtime kanál
 * opravdu přihlášený; jinak „obnoveno před X s" podle posledního obnovení.
 * Relativní čas se počítá až v prohlížeči (před mountem nic), aby se serverový
 * a klientský render nerozešly.
 */
export function LiveIndicator({
  connected,
  lastRefreshAt,
  className,
}: {
  connected: boolean;
  lastRefreshAt: number | null;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (connected) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [connected, lastRefreshAt]);

  if (connected) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs text-(--color-muted)", className)}>
        <StatusPulse className="h-1.5 w-1.5" />
        živě
      </span>
    );
  }
  if (now === null || lastRefreshAt === null) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-(--color-faint)", className)}
      title="Živé změny teď nechodí — stránka se obnovuje pravidelně."
    >
      <StatusPulse tone="muted" pulse={false} className="h-1.5 w-1.5" />
      obnoveno {formatRelative(new Date(lastRefreshAt), new Date(Math.max(now, lastRefreshAt)))}
    </span>
  );
}
