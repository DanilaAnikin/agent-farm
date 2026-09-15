import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-5 w-5 animate-spin rounded-full border-2 border-(--color-muted) border-t-transparent",
        className,
      )}
      aria-label="Načítání"
    />
  );
}
