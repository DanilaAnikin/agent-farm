import { cn } from "@/lib/cn";

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
      ? "bg-[--color-info]"
      : tone === "warn"
        ? "bg-[--color-warn]"
        : tone === "danger"
          ? "bg-[--color-danger]"
          : tone === "muted"
            ? "bg-[--color-faint]"
            : "bg-[--color-brand]";
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color, pulse && "status-pulse", className)}
    />
  );
}
