import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // vrstvený povrch + elevace horní světelnou hranou (elev-1), jemný gradient
        // shora; hover zvedne na elev-2 + surface-2 (žije).
        "elev-1 rounded-(--radius-lg) bg-(--color-surface-1) bg-[linear-gradient(180deg,#ffffff05,transparent_42%)] transition-[box-shadow,background] duration-150 hover:elev-2 hover:bg-(--color-surface-2)",
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
    <div className={cn("flex items-start justify-between gap-4 border-b border-(--color-border-subtle) px-5 py-4", className)}>
      <div className="min-w-0">
        <h3 className="t-heading truncate text-(--color-fg)">{title}</h3>
        {description ? <p className="t-meta mt-1">{description}</p> : null}
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
    <div className={cn("border-t border-(--color-border-subtle) px-5 py-3", className)} {...props} />
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
      ? "text-(--color-ok)"
      : tone === "warn"
        ? "text-(--color-warn)"
        : tone === "danger"
          ? "text-(--color-danger)"
          : "text-(--color-fg)";
  return (
    <div className="elev-1 rounded-(--radius-md) bg-(--color-surface-1) px-4 py-3">
      <div className="t-eyebrow">{label}</div>
      <div className={cn("t-metric mt-1.5 text-2xl", toneClass)}>{value}</div>
      {hint ? <div className="t-meta mt-1">{hint}</div> : null}
    </div>
  );
}
