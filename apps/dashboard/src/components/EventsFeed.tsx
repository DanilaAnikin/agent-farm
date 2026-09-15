import { formatDate, formatRelative } from "@/lib/format";
import { Activity } from "lucide-react";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { groupEvents, type FeedEvent, type FeedLevel } from "@/components/swarm/event-groups";

const levelColor: Record<FeedLevel, string> = {
  debug: "bg-[--color-border-strong]",
  info: "bg-[--color-info]",
  warn: "bg-[--color-warn]",
  error: "bg-[--color-danger]",
};

/**
 * Živé události projektu nebo přání.
 *
 * Dřív vypisoval syrové kódy typů („backlog_task_archived") a každou z 200
 * archivačních událostí zvlášť. Teď: český popisek z lib/event-labels.ts,
 * hromadné akce se stejným `run_id` a opakující se typy v jednom řádku,
 * provozní šum ztlumený. Chyba načtení se hlásí, nevydává se za „žádné události".
 */
export function EventsFeed({
  events,
  error,
  limit = 40,
}: {
  events: FeedEvent[];
  error?: string | null;
  limit?: number;
}) {
  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-[--color-warn]/30 bg-[--color-warn-bg]/40 px-3 py-2 text-xs text-[--color-warn]">
        {error}
      </p>
    );
  }
  const skupiny = groupEvents(events).slice(0, limit);
  if (skupiny.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="size-5" />}
        title="Za posledních 7 dní žádné události"
        description="Jakmile agenti začnou pracovat, objeví se tu živý stream."
      />
    );
  }
  return (
    <ol className="relative space-y-3">
      {skupiny.map((g) => (
        <li key={g.key} className={cn("flex gap-3", g.importance === "noise" && "opacity-60")}>
          <span className="mt-1.5 flex flex-col items-center">
            <span className={`h-2 w-2 shrink-0 rounded-full ${levelColor[g.level] ?? levelColor.info}`} />
          </span>
          <div className="min-w-0 flex-1 border-b border-[--color-border] pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-[--color-muted]" title={g.type}>
                {g.label}
                {g.count > 1 ? <span className="text-[--color-faint]"> · {g.count}×</span> : null}
              </span>
              <span
                className="shrink-0 text-xs text-[--color-faint]"
                title={`${formatDate(g.ts)} (Europe/Prague)`}
                suppressHydrationWarning
              >
                {formatRelative(g.ts)}
              </span>
            </div>
            {g.text && g.text !== g.label ? (
              <p className="mt-0.5 break-words text-sm text-[--color-fg]">{g.text}</p>
            ) : null}
            {g.latest.pr_url ? (
              <a
                href={g.latest.pr_url}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-block text-xs text-[--color-brand] hover:underline"
              >
                Otevřít pull request
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
