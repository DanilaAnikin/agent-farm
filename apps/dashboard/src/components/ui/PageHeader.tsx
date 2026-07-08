import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-sm text-[--color-muted]">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
