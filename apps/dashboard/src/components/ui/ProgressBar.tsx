import { cn } from "@/lib/cn";

// Ukazatel útraty vůči stropu; zabarví se dle poměru.
export function ProgressBar({
  ratio,
  className,
}: {
  ratio: number;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const color =
    ratio >= 0.9 ? "bg-[--color-danger]" : ratio >= 0.7 ? "bg-[--color-warn]" : "bg-[--color-ok]";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[--color-surface-2]", className)}>
      <div
        className={cn("h-full rounded-full transition-all", color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
