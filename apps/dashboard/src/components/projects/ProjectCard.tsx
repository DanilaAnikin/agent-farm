"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { StatusPulse } from "@/components/ui/Live";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/lib/cn";
import { ProjectMessageBox } from "@/components/projects/ProjectMessageBox";
import { PauseResumeButton } from "@/components/projects/PauseResumeButton";
import { PROJECT_KIND_META, PROJECT_STATUS_META } from "@/lib/constants";
import { formatPercent, formatRelative, formatUsd, spendRatio } from "@/lib/format";
import { countLabel, plural, TVARY } from "@/lib/plural";
import { progressBreakdown, type ProjectProgress } from "@/components/swarm/queue";
import type { WishTone } from "@/components/projects/wish-status";
import { projectIdleSentence, projectStatusLine, projectWaitingPredicate } from "@/components/projects/project-status";
import type { ProjectRow } from "@/lib/types";

export interface ProjectCardWish {
  id: string;
  title: string;
  /** Odvozený stav (effectiveWishStatus), ne syrový wishes.status. */
  label: string;
  tone: WishTone;
  hint: string | null;
  done: number;
  total: number;
}

export interface ProjectCardData {
  project: ProjectRow;
  todaySpend: number;
  busyAgents: number;
  /** Poslední smysluplná událost projektu (RPC project_last_event). */
  lastEvent?: { label: string; message: string; ts: string } | null;
  progress: ProjectProgress;
  /** Rozpracovaná přání (jen u běžícího projektu). */
  activeWishes: ProjectCardWish[];
  /** Počet otevřených přání (i v pozastaveném projektu). */
  openWishCount: number;
  managerNote: string | null;
  /** Stav farmy: null = běží, jinak krátký důvod, proč stojí. */
  farmStopReason: string | null;
}

const PRACUJE = ["pracuje", "pracují", "pracuje"] as const;
const CEKA = ["čeká", "čekají", "čeká"] as const;

export function ProjectCard({ data }: { data: ProjectCardData }) {
  const { project, todaySpend, busyAgents, lastEvent, progress, activeWishes, openWishCount, managerNote, farmStopReason } =
    data;
  const [messaging, setMessaging] = useState(false);
  const cap = project.daily_cap_usd;
  const maRozpocet = cap > 0;
  const ratio = spendRatio(todaySpend, cap);
  const bezi = project.status === "active";

  const busy = busyAgents > 0;
  return (
    // Běžící projekt dostane living lifeline na levé hraně (idle nemá → okamžitě odliší „žije").
    <Card className={cn("relative flex flex-col overflow-hidden p-5", busy && "lifeline")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/projects/${project.id}`} className="t-heading truncate hover:text-[--color-brand]">
            {project.name}
          </Link>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusBadge meta={PROJECT_KIND_META[project.kind]} />
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[--color-brand]">
                <StatusPulse />
                {countLabel(busyAgents, TVARY.agent)} {plural(busyAgents, PRACUJE)}
              </span>
            ) : null}
          </div>
        </div>
        <StatusBadge meta={PROJECT_STATUS_META[project.status]} dot pulse={busy} />
      </div>

      {/* Stav farmy NAD stavem projektu — aktivní projekt na stojící farmě nepracuje. */}
      <p className={cn("mt-2 text-xs", bezi && farmStopReason ? "text-[--color-warn]" : "text-[--color-muted]")}>
        {projectStatusLine(project.status)} · {farmStopReason ? `farma stojí: ${farmStopReason}` : "farma běží"}
      </p>

      {/* Postup projektu bez archivované historické fronty */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="t-eyebrow">Postup</span>
          <span className="t-metric text-xs text-[--color-tertiary]">{formatPercent(progress.ratio)}</span>
        </div>
        <ProgressBar ratio={progress.ratio} />
        <p className="text-[11px] text-[--color-faint]">{progressBreakdown(progress)}</p>
      </div>

      {/* Přání: u stojícího projektu jen jeden řádek, jinak rozpracovaná s postupem */}
      {!bezi ? (
        <p className="mt-4 text-xs text-[--color-muted]">
          {openWishCount > 0
            ? `${countLabel(openWishCount, TVARY.prani)} ${plural(openWishCount, CEKA)}, projekt ${projectWaitingPredicate(project.status)}.`
            : projectIdleSentence(project.status)}
        </p>
      ) : activeWishes.length > 0 ? (
        <ul className="mt-4 space-y-2.5">
          {activeWishes.slice(0, 3).map((w) => (
            <li key={w.id}>
              <Link
                href={`/projects/${project.id}/wishes/${w.id}`}
                className="group block rounded-[--radius-md] border border-[--color-border-subtle] bg-[--color-bg-sunken]/40 px-2.5 py-2 transition-colors hover:border-[--color-border-strong] hover:bg-[--color-surface-2]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-[--color-muted] group-hover:text-[--color-fg]">
                    {w.title}
                  </span>
                  <span title={w.hint ?? undefined}>
                    <Badge tone={w.tone}>{w.label}</Badge>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <ProgressBar ratio={w.total > 0 ? w.done / w.total : 0} className="flex-1" />
                  <span className="t-metric shrink-0 text-[11px] text-[--color-tertiary]">
                    {formatPercent(w.total > 0 ? w.done / w.total : 0)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
          {activeWishes.length > 3 ? (
            <li className="text-xs text-[--color-faint]">
              + další {countLabel(activeWishes.length - 3, TVARY.prani)}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-[--color-muted]">
          {farmStopReason
            ? `Žádná rozpracovaná přání — práce se doplní, až farma naběhne (${farmStopReason}).`
            : "Žádná rozpracovaná přání — farma sama doplní další práci v příštím kole."}
        </p>
      )}

      {/* Útrata — teplá škála (rozpočet, ne růst) řeší ProgressBar dle ratia */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between">
          <span
            className="t-eyebrow"
            title="Denní okno stropu je v UTC: 02:00–02:00 Europe/Prague (v zimě 01:00–01:00)."
          >
            Dnes (UTC)
          </span>
          <span className="t-metric text-xs">
            {maRozpocet ? (
              <>
                {formatUsd(todaySpend)} <span className="text-[--color-tertiary]">/ {formatUsd(cap, "cap")}</span>
              </>
            ) : (
              <span className="text-[--color-tertiary]">
                {todaySpend > 0 ? `${formatUsd(todaySpend)} · ` : ""}bez rozpočtu
              </span>
            )}
          </span>
        </div>
        {maRozpocet ? <ProgressBar ratio={ratio} kind="budget" /> : null}
      </div>

      {lastEvent ? (
        <div className="mt-3 truncate text-xs" title={lastEvent.message}>
          <span className="text-[--color-tertiary]" suppressHydrationWarning>
            {formatRelative(lastEvent.ts)}:{" "}
          </span>
          <span className="text-[--color-muted]">{lastEvent.label}</span>
        </div>
      ) : null}

      {/* Akce: zadat úkol + pauza/spuštění */}
      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-2 border-t border-[--color-border-subtle] pt-3">
          <button
            type="button"
            onClick={() => setMessaging((v) => !v)}
            aria-expanded={messaging}
            className="ring-focus inline-flex h-8 items-center gap-1.5 rounded-[--radius-sm] border border-[--color-border] bg-[--color-surface-2] px-3 text-xs font-medium text-[--color-muted] transition-colors hover:border-[--color-border-strong] hover:text-[--color-fg]"
          >
            <MessageSquare className="size-3.5" /> {messaging ? "Zavřít" : "Zadat úkol"}
          </button>
          <PauseResumeButton projectId={project.id} status={project.status} size="sm" />
        </div>

        {messaging ? (
          <div className="mt-3 rounded-lg border border-[--color-border] bg-[--color-surface-2]/50 p-3">
            <ProjectMessageBox
              projectId={project.id}
              initialNote={managerNote}
              compact
              projectPaused={!bezi}
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
