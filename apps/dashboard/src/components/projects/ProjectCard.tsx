"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/Badge";
import { StatusPulse } from "@/components/ui/Live";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/lib/cn";
import { ProjectMessageBox } from "@/components/projects/ProjectMessageBox";
import { PauseResumeButton } from "@/components/projects/PauseResumeButton";
import { PROJECT_KIND_META, PROJECT_STATUS_META, WISH_STATUS_META } from "@/lib/constants";
import { formatRelative, formatUsd, spendRatio } from "@/lib/format";
import type { ProjectRow, WishStatus } from "@/lib/types";

export interface ProjectCardWish {
  id: string;
  title: string;
  status: WishStatus;
  done: number;
  total: number;
}

export interface ProjectCardData {
  project: ProjectRow;
  todaySpend: number;
  busyAgents: number;
  lastEvent?: { message: string; ts: string } | null;
  progress: { done: number; total: number };
  activeWishes: ProjectCardWish[];
  managerNote: string | null;
}

export function ProjectCard({ data }: { data: ProjectCardData }) {
  const { project, todaySpend, busyAgents, lastEvent, progress, activeWishes, managerNote } = data;
  const [messaging, setMessaging] = useState(false);
  const ratio = spendRatio(todaySpend, project.daily_cap_usd);
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const busy = busyAgents > 0;
  return (
    // Běžící projekt dostane living lifeline na levé hraně (idle nemá → okamžitě odliší „žije").
    <Card className={cn("relative flex h-full flex-col overflow-hidden p-5", busy && "lifeline")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/projects/${project.id}`}
            className="t-heading truncate hover:text-[--color-brand]"
          >
            {project.name}
          </Link>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusBadge meta={PROJECT_KIND_META[project.kind]} />
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[--color-brand]">
                <StatusPulse />
                {busyAgents} {busyAgents === 1 ? "agent" : "agentů"} pracuje
              </span>
            ) : null}
          </div>
        </div>
        <StatusBadge meta={PROJECT_STATUS_META[project.status]} dot pulse={busy} />
      </div>

      {/* Postup projektu (hotové/celkem úkolů) */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="t-eyebrow">Postup</span>
          <span className="t-metric text-xs text-[--color-tertiary]">
            {progress.done}/{progress.total} úkolů · {pct} %
          </span>
        </div>
        <ProgressBar ratio={progress.total > 0 ? progress.done / progress.total : 0} />
      </div>

      {/* Aktivní přání s vlastními progress bary */}
      {activeWishes.length > 0 ? (
        <ul className="mt-4 space-y-2.5">
          {activeWishes.slice(0, 3).map((w) => {
            const wpct = w.total > 0 ? Math.round((w.done / w.total) * 100) : 0;
            return (
              <li key={w.id}>
                <Link
                  href={`/projects/${project.id}/wishes/${w.id}`}
                  className="group block rounded-[--radius-md] border border-[--color-border-subtle] bg-[--color-bg-sunken]/40 px-2.5 py-2 transition-colors hover:border-[--color-border-strong] hover:bg-[--color-surface-2]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm text-[--color-muted] group-hover:text-[--color-fg]">
                      {w.title}
                    </span>
                    <StatusBadge meta={WISH_STATUS_META[w.status]} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <ProgressBar
                      ratio={w.total > 0 ? w.done / w.total : 0}
                      className="flex-1"
                    />
                    <span className="t-metric shrink-0 text-[11px] text-[--color-tertiary]">
                      {wpct}%
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
          {activeWishes.length > 3 ? (
            <li className="text-xs text-[--color-faint]">+ {activeWishes.length - 3} dalších přání</li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-[--color-muted]">
          Žádná aktivní přání — pošli projektu instrukci níže.
        </p>
      )}

      {/* Útrata — teplá škála (rozpočet, ne růst) řeší ProgressBar dle ratia */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="t-eyebrow">Dnešní útrata</span>
          <span className="t-metric text-xs">
            {formatUsd(todaySpend)}{" "}
            <span className="text-[--color-tertiary]">/ {formatUsd(project.daily_cap_usd)}</span>
          </span>
        </div>
        <ProgressBar ratio={ratio} kind="budget" />
      </div>

      {lastEvent ? (
        <div className="mt-3 truncate text-xs">
          <span className="text-[--color-tertiary]">{formatRelative(lastEvent.ts)}: </span>
          <span className="text-[--color-muted]">{lastEvent.message}</span>
        </div>
      ) : null}

      {/* Akce: zpráva projektu + pauza/spuštění */}
      <div className="mt-auto pt-4">
        <div className="flex items-center gap-2 border-t border-[--color-border-subtle] pt-3">
          <button
            type="button"
            onClick={() => setMessaging((v) => !v)}
            className="ring-focus inline-flex h-8 items-center gap-1.5 rounded-[--radius-sm] border border-[--color-border] bg-[--color-surface-2] px-3 text-xs font-medium text-[--color-muted] transition-colors hover:border-[--color-border-strong] hover:text-[--color-fg]"
          >
            <MessageSquare className="size-3.5" /> {messaging ? "Zavřít" : "Zpráva projektu"}
          </button>
          <PauseResumeButton projectId={project.id} status={project.status} size="sm" />
        </div>

        {messaging ? (
          <div className="mt-3 rounded-lg border border-[--color-border] bg-[--color-surface-2]/50 p-3">
            <ProjectMessageBox projectId={project.id} initialNote={managerNote} compact />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
