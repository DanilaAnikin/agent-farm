import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[--color-border] bg-[--color-surface] shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-[--color-border] px-5 py-4", className)}>
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-[--color-fg]">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-[--color-muted]">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("border-t border-[--color-border] px-5 py-3", className)} {...props} />
  );
}

// Malá metrika (KPI) do mřížky.
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "ok" | "warn" | "danger" | "default";
}) {
  const toneClass =
    tone === "ok"
      ? "text-[--color-ok]"
      : tone === "warn"
        ? "text-[--color-warn]"
        : tone === "danger"
          ? "text-[--color-danger]"
          : "text-[--color-fg]";
  return (
    <div className="rounded-lg border border-[--color-border] bg-[--color-surface-2] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[--color-muted]">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-[--color-muted]">{hint}</div> : null}
    </div>
  );
}
