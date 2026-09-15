"use client";

// Řeka aktivity — proud posledních událostí napříč všemi projekty.
// Nejnovější nahoře. Po sobě jdoucí události stejného typu a hromadné akce
// (stejné data.run_id) se slučují do jednoho řádku, takže archivace 201 úkolů
// už nezahltí celý seznam. Filtr „jen důležité" schová provozní šum.
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, formatRelative } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { groupEvents, type EventGroup, type FeedEvent } from "./event-groups";

function Ikona({ g }: { g: EventGroup }) {
  const cls = "size-3.5 shrink-0";
  if (g.type.startsWith("backlog_")) return <Archive className={cn(cls, "text-[--color-faint]")} />;
  if (g.level === "error" || g.tone === "danger")
    return <XCircle className={cn(cls, "text-[--color-danger]")} />;
  if (g.level === "warn" || g.tone === "warn")
    return <AlertTriangle className={cn(cls, "text-[--color-warn]")} />;
  if (g.tone === "ok") return <CheckCircle2 className={cn(cls, "text-[--color-ok]")} />;
  return <CircleDot className={cn(cls, "text-[--color-brand]")} />;
}

export function ActivityRiver({
  events,
  projectNames,
  error,
}: {
  events: FeedEvent[];
  /** id projektu → název (Map se do klientské komponenty serializovat nedá). */
  projectNames: Record<string, string>;
  /** Česká hláška, když se události nepodařilo načíst (nesmí vypadat jako „ticho"). */
  error?: string | null;
}) {
  const [jenDulezite, setJenDulezite] = useState(true);
  const skupiny = useMemo(
    () => groupEvents(events, { onlyImportant: jenDulezite }),
    [events, jenDulezite],
  );

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-[--color-warn]/30 bg-[--color-warn-bg]/40 px-3 py-2 text-xs text-[--color-warn]">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-[--color-muted]">
        <input
          type="checkbox"
          checked={jenDulezite}
          onChange={(e) => setJenDulezite(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-[--color-border-strong] bg-[--color-surface-2]"
        />
        Jen důležité (bez provozního šumu)
      </label>

      {skupiny.length === 0 ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="Za posledních 7 dní nic důležitého"
          description={
            jenDulezite
              ? "Provozní šum je skrytý — vypni filtr, pokud chceš vidět všechno."
              : "V posledních 7 dnech farma nezapsala žádnou událost."
          }
        />
      ) : (
        <ul className="max-h-[36rem] space-y-0.5 overflow-y-auto">
          {skupiny.map((g) => {
            const e = g.latest;
            const pid = e.project_id ?? null;
            const projekt = pid ? (projectNames[pid] ?? "Projekt") : "Farma";
            const odkaz = pid
              ? e.wish_id
                ? `/projects/${pid}/wishes/${e.wish_id}`
                : `/projects/${pid}`
              : null;
            return (
              <li
                key={g.key}
                className={cn(
                  "group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[--color-surface-2]",
                  g.importance === "noise" && "opacity-70",
                )}
              >
                <span className="mt-0.5" aria-label={g.label} title={g.label}>
                  <Ikona g={g} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    {odkaz ? (
                      <Link
                        href={odkaz}
                        className="truncate text-xs font-medium text-[--color-faint] hover:text-[--color-fg]"
                      >
                        {projekt}
                      </Link>
                    ) : (
                      <span className="truncate text-xs font-medium text-[--color-faint]">{projekt}</span>
                    )}
                    <span
                      className="shrink-0 text-[10px] tabular-nums text-[--color-faint]"
                      title={`${formatDate(g.ts)} (Europe/Prague)`}
                      suppressHydrationWarning
                    >
                      {formatRelative(g.ts)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[--color-muted] group-hover:text-[--color-fg]">
                    {g.count > 1 ? null : <span className="text-[--color-faint]">{g.label}: </span>}
                    {g.text}
                  </p>
                  {e.pr_url ? (
                    <a
                      href={e.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[--color-brand] hover:underline"
                    >
                      Pull request <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
