import { cn } from "@/lib/cn";

/**
 * Ukazatel poměru. Sémanticky odlišené (rozbíjí „všechno zelené"):
 *  - kind="progress" (default) = RŮST → brand zelená (task/wish completion).
 *  - kind="budget" = NÁKLAD/LIMIT → TEPLÁ sekvenční škála (safe → caution → over),
 *    NIKDY zelená (jinak splývá rozpočet s postupem).
 */
export function ProgressBar({
  ratio,
  kind = "progress",
  className,
}: {
  ratio: number;
  kind?: "progress" | "budget";
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const color =
    kind === "budget"
      ? ratio >= 0.85
        ? "bg-[--color-budget-over]"
        : ratio >= 0.6
          ? "bg-[--color-budget-caution]"
          : "bg-[--color-budget-safe]"
      : "bg-[--color-brand]";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[--color-track]", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
