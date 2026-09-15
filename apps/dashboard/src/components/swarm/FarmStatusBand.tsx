// Pás „Stav farmy" — nahoře na velínu i na /projects. Jedna věta pravdy o tom,
// co farma dělá nebo proč nedělá nic, od kdy to platí, kdy začne příští levné
// okno a kolik se dnes a tento měsíc utratilo proti stropům farmy.
import { AlertTriangle, CircleDot, PauseCircle, PlayCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatDate, formatTimeShort, formatUsd, spendRatio } from "@/lib/format";
import type { FarmHeadline } from "./farm-headline";

const TON: Record<FarmHeadline["tone"], string> = {
  ok: "border-(--color-ok)/25 bg-(--color-ok-bg)/25",
  info: "border-(--color-info)/25 bg-(--color-info-bg)/30",
  warn: "border-(--color-warn)/30 bg-(--color-warn-bg)/30",
  danger: "border-(--color-danger)/30 bg-(--color-danger-bg)/35",
  neutral: "border-(--color-border) bg-(--color-surface-1)",
};

function Ikona({ tone }: { tone: FarmHeadline["tone"] }) {
  const cls = "size-5 shrink-0";
  if (tone === "ok") return <PlayCircle className={cn(cls, "text-(--color-ok)")} />;
  if (tone === "danger") return <XCircle className={cn(cls, "text-(--color-danger)")} />;
  if (tone === "warn") return <PauseCircle className={cn(cls, "text-(--color-warn)")} />;
  if (tone === "info") return <CircleDot className={cn(cls, "text-(--color-info)")} />;
  return <CircleDot className={cn(cls, "text-(--color-muted)")} />;
}

export interface FarmStatusBandProps {
  headline: FarmHeadline;
  /** Stav se nečetl autoritativně — pás to musí přiznat. */
  degradedReason?: string | null;
  /** Od kdy aktuální stav platí (ISO). */
  sinceIso?: string | null;
  /** Začátek příštího levného okna (ISO), když ho jde určit. */
  nextOffpeakIso?: string | null;
  todaySpend: number | null;
  dailyCap: number;
  monthSpend: number | null;
  monthlyCap: number;
  /** „Září" — název aktuálního měsíce. */
  monthLabel: string;
  spendError?: string | null;
  /** Odkud čísla útraty jsou („započteno hlídačem…"), ať se nepletou se změřenými. */
  spendSourceLabel?: string | null;
  /** Když stránka větu už má v nadpisu, pás ukáže jen podrobnosti. */
  showTitle?: boolean;
}

export function FarmStatusBand({
  showTitle = true,
  headline,
  degradedReason,
  sinceIso,
  nextOffpeakIso,
  todaySpend,
  dailyCap,
  monthSpend,
  monthlyCap,
  monthLabel,
  spendError,
  spendSourceLabel,
}: FarmStatusBandProps) {
  return (
    <section
      aria-label="Stav farmy"
      className={cn("rounded-(--radius-lg) border px-4 py-3.5 sm:px-5", TON[headline.tone])}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Ikona tone={headline.tone} />
          <div className="min-w-0">
            <div className="t-eyebrow">Stav farmy</div>
            {showTitle ? (
              <p className="mt-0.5 text-[15px] font-semibold text-(--color-fg)">{headline.title}</p>
            ) : null}
            <p className="mt-0.5 text-sm text-(--color-muted)">{headline.detail}</p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-(--color-faint)">
              {sinceIso ? <span>stav platí od {formatDate(sinceIso)}</span> : null}
              {nextOffpeakIso ? (
                <span>příští levné okno v {formatTimeShort(nextOffpeakIso)}</span>
              ) : null}
              <span>časy v Europe/Prague</span>
            </p>
          </div>
        </div>

        <div className="grid w-full shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:w-[26rem]">
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-(--color-muted)" title="Denní strop se počítá v UTC (02:00–02:00 Europe/Prague v létě)">
                Dnes (UTC)
              </span>
              <span className="t-metric text-(--color-fg)">
                {todaySpend === null ? "—" : formatUsd(todaySpend)}{" "}
                <span className="text-(--color-tertiary)">/ {formatUsd(dailyCap, "cap")}</span>
              </span>
            </div>
            <ProgressBar ratio={spendRatio(todaySpend ?? 0, dailyCap)} kind="budget" className="mt-1.5" />
          </div>
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-(--color-muted)">{monthLabel}</span>
              <span className="t-metric text-(--color-fg)">
                {monthSpend === null ? "—" : formatUsd(monthSpend)}{" "}
                <span className="text-(--color-tertiary)">/ {formatUsd(monthlyCap, "cap")}</span>
              </span>
            </div>
            <ProgressBar ratio={spendRatio(monthSpend ?? 0, monthlyCap)} kind="budget" className="mt-1.5" />
          </div>
          {spendSourceLabel ? (
            <p className="t-micro text-(--color-faint) sm:col-span-2 sm:text-right">{spendSourceLabel}</p>
          ) : null}
        </div>
      </div>

      {degradedReason || spendError ? (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-xs text-(--color-warn)">
          <AlertTriangle className="size-3.5 shrink-0" />
          {[degradedReason, spendError].filter(Boolean).join(" ")}
        </p>
      ) : null}
    </section>
  );
}

/** „Září" — název měsíce v češtině (1. pád), podle UTC, protože i strop je v UTC. */
export function monthLabelCs(now: Date = new Date()): string {
  const nazev = new Intl.DateTimeFormat("cs-CZ", { month: "long", timeZone: "UTC" }).format(now);
  return nazev.charAt(0).toUpperCase() + nazev.slice(1);
}
