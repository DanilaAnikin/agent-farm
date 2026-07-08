import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon = "◇",
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-[--color-border-strong] bg-[--color-surface]/40 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[--color-surface-2] text-xl text-[--color-muted]">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-[--color-fg]">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-[--color-muted]">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
