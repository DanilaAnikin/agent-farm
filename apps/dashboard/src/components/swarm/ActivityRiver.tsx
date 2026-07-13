// Řeka aktivity — živý proud posledních událostí napříč všemi projekty.
// Nejnovější nahoře, jemné, čitelné na jeden pohled.
import { cn } from "@/lib/cn";
import { Activity } from "lucide-react";
import { formatRelative } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import type { EventLevel } from "@/lib/types";

export interface RiverEvent {
  id: string;
  ts: string;
  projectName: string | null;
  message: string;
  level: EventLevel;
}

const LEVEL_DOT: Record<EventLevel, string> = {
  debug: "bg-[--color-faint]",
  info: "bg-[--color-brand]",
  warn: "bg-[--color-warn]",
  error: "bg-[--color-danger]",
};

export function ActivityRiver({ events }: { events: RiverEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="size-5" />}
        title="Zatím ticho"
        description="Jakmile roj něco udělá, objeví se to tady živě."
      />
    );
  }

  return (
    <ul className="space-y-0.5">
      {events.map((e) => (
        <li
          key={e.id}
          className="group flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[--color-surface-2]"
        >
          <span
            className={cn(
              "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
              LEVEL_DOT[e.level] ?? "bg-[--color-faint]",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-[--color-faint]">
                {e.projectName ?? "Farma"}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-[--color-faint]">
                {formatRelative(e.ts)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-[--color-muted] group-hover:text-[--color-fg]">
              {e.message}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
