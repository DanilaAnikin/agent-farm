import { formatRelative } from "@/lib/format";
import { Activity } from "lucide-react";
import type { EventLevel, EventRow } from "@/lib/types";
import { EmptyState } from "@/components/ui/EmptyState";

const levelColor: Record<EventLevel, string> = {
  debug: "bg-[--color-border-strong]",
  info: "bg-[--color-info]",
  warn: "bg-[--color-warn]",
  error: "bg-[--color-danger]",
};

export function EventsFeed({ events }: { events: Pick<EventRow, "id" | "level" | "type" | "message" | "ts">[] }) {
  if (events.length === 0) {
    return <EmptyState icon={<Activity className="size-5" />} title="Zatím žádné události" description="Jakmile agenti začnou pracovat, objeví se tu živý stream." />;
  }
  return (
    <ol className="relative space-y-3">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3">
          <span className="mt-1.5 flex flex-col items-center">
            <span className={`h-2 w-2 shrink-0 rounded-full ${levelColor[e.level]}`} />
          </span>
          <div className="min-w-0 flex-1 border-b border-[--color-border] pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-[--color-muted]">{e.type}</span>
              <span className="shrink-0 text-xs text-[--color-faint]">{formatRelative(e.ts)}</span>
            </div>
            {e.message ? <p className="mt-0.5 break-words text-sm text-[--color-fg]">{e.message}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
