import { StatusBadge } from "@/components/ui/Badge";
import { ParkedTaskActions } from "@/components/wishes/ParkedTaskActions";
import { ATTEMPT_STATUS_META, JUDGE_VERDICT_META, TASK_KIND_META, TASK_STATUS_META } from "@/lib/constants";
import { formatDuration, formatRelative, formatUsd } from "@/lib/format";
import type { AttemptRow, ReviewRow, TaskRow } from "@/lib/types";

export interface TaskTreeData {
  task: TaskRow;
  attempts: AttemptRow[];
  reviewsByAttempt: Map<string, ReviewRow>;
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
        const isParked = task.status === "parked" || task.status === "failed";
        return (
          <li key={task.id} className="rounded-lg border border-[--color-border] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusBadge meta={TASK_KIND_META[task.kind]} />
                  <span className="truncate font-medium">{task.title}</span>
                </div>
                <p className="mt-1 text-xs text-[--color-muted]">
                  <span className="text-[--color-faint]">Podmínka: </span>
                  {task.done_condition}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StatusBadge meta={TASK_STATUS_META[task.status]} dot />
                <span className="text-xs text-[--color-faint]">
                  {task.attempts_count}/{task.max_attempts} pokusů
                </span>
              </div>
            </div>

            {/* Pokusy (u zaparkovaných / selhaných rozbalené s plným kontextem) */}
            {attempts.length > 0 ? (
              <div className="mt-3 space-y-2 border-t border-[--color-border] pt-3">
                {attempts.map((a) => {
                  const review = reviewsByAttempt.get(a.id);
                  const diff = a.diff_stat as { additions?: number; deletions?: number; files?: number } | null;
                  return (
                    <div key={a.id} className="rounded-md bg-[--color-surface-2] p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge meta={ATTEMPT_STATUS_META[a.status]} />
                          {a.model ? <span className="text-[--color-faint]">{a.model}</span> : null}
                        </div>
                        <span className="text-[--color-faint]">{formatRelative(a.started_at)}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[--color-muted]">
                        <span>{a.steps_used} kroků</span>
                        <span>{formatDuration(a.wall_ms ? a.wall_ms / 1000 : null)}</span>
                        <span>{formatUsd(a.cost_usd)}</span>
                        {diff ? (
                          <span>
                            +{diff.additions ?? 0} / -{diff.deletions ?? 0} ({diff.files ?? 0} souborů)
                          </span>
                        ) : null}
                      </div>
                      {a.output_summary ? (
                        <p className="mt-1.5 whitespace-pre-wrap text-[--color-fg]">{a.output_summary}</p>
                      ) : null}
                      {review ? (
                        <div className="mt-2 border-t border-[--color-border] pt-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[--color-faint]">Judge:</span>
                            <StatusBadge meta={JUDGE_VERDICT_META[review.verdict]} />
                          </div>
                          {review.reasons ? (
                            <p className="mt-1 whitespace-pre-wrap text-[--color-muted]">{review.reasons}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {isParked ? (
              <ParkedTaskActions taskId={task.id} projectId={projectId} wishId={wishId} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
