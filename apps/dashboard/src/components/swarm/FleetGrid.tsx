// Živá mřížka roje — jedna dlaždice na každého právě pracujícího agenta.
// Hustá responzivní mřížka, takže N paralelních agentů vypadá jako skutečný roj.
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ROLE_ORDER, formatElapsed, roleMeta } from "./roles";
import type { AgentRole } from "@/lib/types";

export interface FleetAgent {
  id: string;
  role: AgentRole;
  model: string | null;
  projectName: string | null;
  taskTitle: string | null;
  /** Odkaz na přání/projekt úkolu, pokud je znám. */
  href?: string | null;
  // Doba běhu aktuálního pokusu (s). Null = neznámá.
  runningSeconds: number | null;
}

/**
 * Prázdný stav NEVYZÝVÁ člověka k zásahu („zadej přání a agenti se probudí").
 * Důvod nečinnosti přichází ze stavu farmy (farmHeadline) — farma si práci
 * doplňuje sama, nebo stojí z důvodu, který stránka říká nahoře.
 */
export function FleetGrid({
  agents,
  emptyTitle,
  emptyDescription,
}: {
  agents: FleetAgent[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (agents.length === 0) {
    return (
      <EmptyState icon={<Bot className="size-5" />} title={emptyTitle} description={emptyDescription} />
    );
  }

  // Seřadíme podle role (vývojáři jádro roje), pak nejdéle běžící napřed.
  const roleRank = new Map<string, number>(ROLE_ORDER.map((r, i) => [r, i] as const));
  const sorted = [...agents].sort((a, b) => {
    const ra = roleRank.get(a.role) ?? 99;
    const rb = roleRank.get(b.role) ?? 99;
    if (ra !== rb) return ra - rb;
    return (b.runningSeconds ?? 0) - (a.runningSeconds ?? 0);
  });

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
      {sorted.map((a) => {
        const meta = roleMeta(a.role);
        return (
          <div
            key={a.id}
            className={cn(
              "relative flex flex-col gap-2 overflow-hidden rounded-xl border p-3 transition-colors",
              meta.tile,
            )}
          >
            {/* Hlavička dlaždice: emoji role + živá tečka */}
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base animate-farm-pulse",
                  meta.chip,
                )}
              >
                {meta.emoji}
              </span>
              <span className={cn("h-2 w-2 shrink-0 rounded-full animate-farm-pulse", meta.dot)} />
            </div>

            {/* Role + model */}
            <div className="min-w-0">
              <div className={cn("truncate text-sm font-semibold", meta.text)}>{meta.label}</div>
              <div className="truncate text-[11px] text-[--color-muted]">{a.model ?? "—"}</div>
            </div>

            {/* Projekt */}
            {a.projectName ? (
              <div className="truncate text-[11px] font-medium text-[--color-faint]">{a.projectName}</div>
            ) : null}

            {/* Aktuální úkol */}
            <div className="line-clamp-2 min-h-[2.25rem] text-xs text-[--color-fg]/90">
              {a.href && a.taskTitle ? (
                <Link href={a.href} className="hover:text-[--color-brand]">
                  {a.taskTitle}
                </Link>
              ) : (
                (a.taskTitle ?? "Pracuje…")
              )}
            </div>

            {/* Doba běhu s pulzem */}
            <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] tabular-nums text-[--color-muted]">
              <span className={cn("h-1.5 w-1.5 rounded-full animate-farm-pulse", meta.dot)} />
              běží {formatElapsed(a.runningSeconds)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
