import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  /** Lucide ikona (size-5). Když chybí, použije se Inbox. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[--radius-lg] border border-dashed border-[--color-border] bg-[--color-surface-1]/40 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-3.5 flex size-14 items-center justify-center rounded-full bg-[--color-surface-2] text-[--color-tertiary]">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <h3 className="t-heading text-[--color-fg]">{title}</h3>
      {description ? <p className="t-body mt-1.5 max-w-sm text-[--color-muted]">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
