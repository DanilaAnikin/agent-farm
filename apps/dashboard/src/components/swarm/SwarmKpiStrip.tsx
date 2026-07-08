// Horní KPI pruh velína roje. Hero = počet ŽIVÝCH agentů právě teď (pulzuje),
// vedle sekundární metriky: aktivní projekty, throughput, náklady/hod, hloubka fronty.
import { cn } from "@/lib/cn";
import { Stat } from "@/components/ui/Card";
import { formatNumber, formatUsd } from "@/lib/format";

export interface SwarmKpis {
  liveAgents: number;
  liveWorkers: number;
  maxWorkers: number | null;
  activeProjects: number;
  throughput: number;
  costPerHour: number;
  queueDepth: number;
}

export function SwarmKpiStrip({ kpis }: { kpis: SwarmKpis }) {
  const { liveAgents, liveWorkers, maxWorkers, activeProjects, throughput, costPerHour, queueDepth } =
    kpis;

  // Poměr obsazenosti roje (živí workeři / kapacita).
  const capRatio =
    maxWorkers && maxWorkers > 0 ? Math.min(1, liveWorkers / maxWorkers) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* HERO — živí agenti právě teď */}
      <div className="relative overflow-hidden rounded-2xl border border-[--color-brand]/30 bg-[--color-brand-soft]/40 p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[--color-brand]">
          <span
            className={cn(
              "h-2 w-2 rounded-full bg-[--color-brand]",
              liveAgents > 0 && "animate-farm-pulse",
            )}
          />
          živých agentů právě teď
        </div>

        <div className="mt-2 flex items-end gap-3">
          <span
            className={cn(
              "text-6xl font-bold leading-none tabular-nums text-[--color-brand]",
              liveAgents > 0 && "animate-farm-pulse",
            )}
          >
            {formatNumber(liveAgents)}
          </span>
          {maxWorkers ? (
            <span className="pb-1 text-sm text-[--color-muted]">
              / až {maxWorkers} workerů
            </span>
          ) : null}
        </div>

        {/* Kapacitní pruh roje */}
        {capRatio !== null ? (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[--color-surface-2]">
              <div
                className="h-full rounded-full brand-gradient-bg transition-all"
                style={{ width: `${Math.round(capRatio * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-[--color-muted]">
              {liveWorkers} z {maxWorkers} paralelních slotů obsazeno
            </p>
          </div>
        ) : (
          <p className="mt-4 text-[11px] text-[--color-muted]">
            {liveWorkers} živých workerů běží souběžně
          </p>
        )}
      </div>

      {/* Sekundární metriky */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:col-span-2">
        <Stat
          label="Aktivní projekty"
          value={formatNumber(activeProjects)}
          tone={activeProjects > 0 ? "ok" : "default"}
        />
        <Stat
          label="Throughput"
          value={formatNumber(throughput)}
          hint="pokusů / hod"
          tone={throughput > 0 ? "ok" : "default"}
        />
        <Stat label="Náklady" value={formatUsd(costPerHour)} hint="za poslední hodinu" />
        <Stat
          label="Fronta"
          value={formatNumber(queueDepth)}
          hint="čeká + běží"
          tone={queueDepth > 0 ? "warn" : "default"}
        />
      </div>
    </div>
  );
}
