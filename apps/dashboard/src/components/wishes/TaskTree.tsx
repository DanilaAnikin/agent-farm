import { Badge, StatusBadge } from "@/components/ui/Badge";
import { ParkedTaskActions } from "@/components/wishes/ParkedTaskActions";
import {
  ARCHIVED_PARK_REASON,
  ATTEMPT_STATUS_META,
  JUDGE_VERDICT_META,
  PARK_REASON_META,
  TASK_KIND_META,
  TASK_STATUS_META,
} from "@/lib/constants";
import { formatDateShort, formatDuration, formatRelative, formatUsd } from "@/lib/format";
import { countLabel } from "@/lib/plural";
import { modelLabel } from "@/lib/admin-guards";
import type { AttemptRow, ReviewRow, TaskRow } from "@/lib/types";

export interface TaskTreeData {
  task: TaskRow;
  attempts: AttemptRow[];
  reviewsByAttempt: Map<string, ReviewRow>;
}

const KROK = ["krok", "kroky", "kroků"] as const;
const SOUBOR = ["soubor", "soubory", "souborů"] as const;

/** Stav úkolu pro badge — u zaparkovaného úkolu říká DŮVOD, ne jen „Zaparkováno" červeně. */
function stavUkolu(task: TaskRow): { label: string; tone: "ok" | "warn" | "danger" | "info" | "neutral" | "violet" } {
  if (task.status === "parked" && task.park_reason) {
    if (task.park_reason === ARCHIVED_PARK_REASON) {
      return {
        label: `Archivováno ${formatDateShort(task.parked_at ?? task.updated_at)} (historická fronta)`,
        tone: "neutral",
      };
    }
    return PARK_REASON_META[task.park_reason] ?? TASK_STATUS_META.parked;
  }
  return TASK_STATUS_META[task.status] ?? { label: task.status, tone: "neutral" };
}

function Pokusy({ attempts, reviewsByAttempt }: Pick<TaskTreeData, "attempts" | "reviewsByAttempt">) {
  return (
    <div className="mt-3 space-y-2 border-t border-(--color-border) pt-3">
      {attempts.map((a) => {
        const review = reviewsByAttempt.get(a.id);
        const diff = a.diff_stat as { additions?: number; deletions?: number; files?: number } | null;
        return (
          <div key={a.id} className="rounded-md bg-(--color-surface-2) p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusBadge meta={ATTEMPT_STATUS_META[a.status]} />
                {a.model ? <span className="text-(--color-faint)">{modelLabel(a.model)}</span> : null}
              </div>
              <span className="text-(--color-faint)" suppressHydrationWarning>
                {formatRelative(a.started_at)}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-(--color-muted)">
              <span>{countLabel(a.steps_used, KROK)}</span>
              <span>{formatDuration(a.wall_ms ? a.wall_ms / 1000 : null)}</span>
              <span>{formatUsd(a.cost_usd)}</span>
              {diff ? (
                <span>
                  +{diff.additions ?? 0} / −{diff.deletions ?? 0} ({countLabel(diff.files ?? 0, SOUBOR)})
                </span>
              ) : null}
            </div>
            {a.output_summary ? (
              <p className="mt-1.5 whitespace-pre-wrap text-(--color-fg)">{a.output_summary}</p>
            ) : null}
            {review ? (
              <div className="mt-2 border-t border-(--color-border) pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-(--color-faint)">Kontrola:</span>
                  <StatusBadge meta={JUDGE_VERDICT_META[review.verdict]} />
                </div>
                {review.reasons ? (
                  <p className="mt-1 whitespace-pre-wrap text-(--color-muted)">{review.reasons}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function TaskTree({
  items,
  projectId,
  wishId,
}: {
  items: TaskTreeData[];
  projectId: string;
  wishId: string;
}) {
  return (
    <ul className="space-y-3">
      {items.map(({ task, attempts, reviewsByAttempt }) => {
        const archiv = task.status === "parked" && task.park_reason === ARCHIVED_PARK_REASON;
        // Ruční zásah jen u skutečné poruchy — archiv ani majitelem zrušený úkol ho nepotřebují.
        const rucniZasah =
          (task.status === "parked" || task.status === "failed") &&
          !archiv &&
          task.park_reason !== "owner_cancelled";
        const stav = stavUkolu(task);
        return (
          <li
            key={task.id}
            className={
              "rounded-lg border border-(--color-border) p-3" + (archiv ? " bg-(--color-surface-1)/40 opacity-80" : "")
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusBadge meta={TASK_KIND_META[task.kind]} />
                  <span className="truncate font-medium">{task.title}</span>
                </div>
                <p className="mt-1 text-xs text-(--color-muted)">
                  <span className="text-(--color-faint)">Podmínka: </span>
                  {task.done_condition}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={stav.tone} dot>
                  {stav.label}
                </Badge>
                <span className="text-xs text-(--color-faint)">
                  {task.attempts_count}/{task.max_attempts} pokusů
                </span>
              </div>
            </div>

            {attempts.length > 0 ? (
              archiv ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-(--color-muted) hover:text-(--color-fg)">
                    Zobrazit původní stav ({countLabel(attempts.length, ["pokus", "pokusy", "pokusů"])})
                  </summary>
                  <Pokusy attempts={attempts} reviewsByAttempt={reviewsByAttempt} />
                </details>
              ) : (
                <Pokusy attempts={attempts} reviewsByAttempt={reviewsByAttempt} />
              )
            ) : null}

            {rucniZasah ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-(--color-muted) hover:text-(--color-fg)">
                  Pokročilé (ruční zásah)
                </summary>
                <ParkedTaskActions taskId={task.id} projectId={projectId} wishId={wishId} />
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
