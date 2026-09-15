// Horní KPI pruh roje. Hero = počet agentů, kteří PRÁVĚ PRACUJÍ (pulzuje), vedle
// sekundární metriky: aktivní projekty, dokončené úkoly a neúspěšné pokusy za 24 h
// a fronta rozdělená na aktivní a pozastavené projekty.
//
// „Pracuje" má na celé dlaždici jeden význam: status busy. Dřív hero počítal
// pracující, ale obsazenost kapacity i nečinné vývojáře s čerstvým signálem.
import { cn } from "@/lib/cn";
import { Stat } from "@/components/ui/Card";
import { formatNumber, formatRelative } from "@/lib/format";
import { countLabel, TVARY } from "@/lib/plural";
import { queueHeadline, queueSubline, type QueueBreakdown } from "./queue";

export interface SwarmKpis {
  /** Agenti, kteří právě pracují (status busy), všechny role. */
  liveAgents: number;
  /** Vývojáři, kteří právě pracují (role worker, status busy) — obsazená kapacita. */
  busyWorkers: number;
  /** Kapacita z `farm_settings.runtime_max_workers_total`; null = neznámá. */
  maxWorkers: number | null;
  activeProjects: number;
  /** null = počet se nepodařilo načíst (neukazovat nulu). */
  doneTasks24h: number | null;
  failedAttempts24h: number | null;
  lastDone: { ts: string; projectName: string | null; taskTitle: string | null; prUrl: string | null } | null;
  queue: QueueBreakdown;
  queueTone: "warn" | "default";
}

export function SwarmKpiStrip({ kpis }: { kpis: SwarmKpis }) {
  const { liveAgents, busyWorkers, maxWorkers, activeProjects, doneTasks24h, failedAttempts24h, lastDone, queue } =
    kpis;

  // Poměr obsazenosti roje (pracující vývojáři / kapacita).
  const capRatio = maxWorkers && maxWorkers > 0 ? Math.min(1, busyWorkers / maxWorkers) : null;
  const podrad = queueSubline(queue);
  const nicZa24h = doneTasks24h === 0 && failedAttempts24h === 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-4 lg:grid-cols-3">
        {/* HERO — agenti, kteří právě pracují */}
        <div className="relative overflow-hidden rounded-2xl border border-[--color-brand]/30 bg-[--color-brand-soft]/40 p-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[--color-brand]">
            <span
              className={cn("h-2 w-2 rounded-full bg-[--color-brand]", liveAgents > 0 && "animate-farm-pulse")}
            />
            právě pracuje
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
            <span className="pb-1 text-sm text-[--color-muted]">
              {maxWorkers ? `kapacita: až ${countLabel(maxWorkers, TVARY.vyvojar)}` : "kapacita neznámá"}
            </span>
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
                Pracující vývojáři: {busyWorkers} z {maxWorkers}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-[11px] text-[--color-muted]">
              Pracující vývojáři: {busyWorkers} (orchestrátor kapacitu nehlásí)
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
            label="Dokončené úkoly (24 h)"
            value={doneTasks24h === null ? "—" : formatNumber(doneTasks24h)}
            hint={doneTasks24h === null ? "nepodařilo se načíst" : undefined}
            tone={doneTasks24h && doneTasks24h > 0 ? "ok" : "default"}
          />
          <Stat
            label="Neúspěšné pokusy (24 h)"
            value={failedAttempts24h === null ? "—" : formatNumber(failedAttempts24h)}
            hint={failedAttempts24h === null ? "nepodařilo se načíst" : "selhané a přerušené"}
            tone={failedAttempts24h && failedAttempts24h > 0 ? "warn" : "default"}
          />
          <Stat
            label="Fronta"
            value={formatNumber(queue.queuedActive)}
            hint={
              <>
                <span className="block">{queueHeadline(queue)}</span>
                {podrad ? <span className="block text-[--color-faint]">{podrad}</span> : null}
              </>
            }
            tone={kpis.queueTone}
          />
        </div>
      </div>

      {nicZa24h ? (
        <p className="text-xs text-[--color-muted]">
          {lastDone ? (
            <>
              Poslední dokončený úkol:{" "}
              <span suppressHydrationWarning>{formatRelative(lastDone.ts)}</span>
              {lastDone.projectName || lastDone.taskTitle ? (
                <>
                  {" "}
                  ({[lastDone.projectName, lastDone.taskTitle].filter(Boolean).join(" · ")}
                  {lastDone.prUrl ? (
                    <>
                      ,{" "}
                      <a href={lastDone.prUrl} target="_blank" rel="noreferrer" className="text-[--color-brand] hover:underline">
                        pull request
                      </a>
                    </>
                  ) : null}
                  )
                </>
              ) : null}
            </>
          ) : (
            "Za posledních 30 dní farma nedokončila žádný úkol."
          )}
        </p>
      ) : null}
    </div>
  );
}
