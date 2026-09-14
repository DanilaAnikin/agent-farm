import { getSql, QUEUES } from "@farm/db";
import type { JudgeMessage } from "./types.js";

export interface JudgingRecovery {
  taskId: string;
  projectId: string;
  attemptId?: string;
  kind: "judge_restored" | "missing_artifact";
}

/** Restore the paid result, never restart a worker because its judge was deferred. */
export async function recoverOrphanedJudging(
  staleMs: number,
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<JudgingRecovery[]> {
  return sql.begin(async (tx) => {
    // Query the queue table itself, not pgmq.read: invisible/delayed messages are
    // still durable work, including a judge waiting for tomorrow's budget.
    // Row locks also serialize concurrent reconciliation instances. Queue send
    // and task updates commit together; a crash cannot lose the recovered result.
    const orphaned = await tx<{
      id: string; project_id: string; wish_id: string | null;
    }[]>`
      SELECT t.id, t.project_id, t.wish_id FROM tasks t
      WHERE t.status = 'judging'
        AND t.updated_at < now() - (${staleMs}::text || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM pgmq.q_q_judge q WHERE q.message->>'taskId' = t.id::text
        )
      ORDER BY t.updated_at
      LIMIT 100
      FOR UPDATE OF t SKIP LOCKED
    `;
    const recovered: JudgingRecovery[] = [];
    for (const task of orphaned) {
      const candidates = await tx<{ id: string; branch: string; worktree_ref: string }[]>`
        SELECT id, branch, worktree_ref FROM attempts
        WHERE task_id = ${task.id} AND status = 'running'
          AND branch IS NOT NULL AND btrim(branch) <> ''
          AND worktree_ref IS NOT NULL AND btrim(worktree_ref) <> ''
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `;
      const attempt = candidates[0];
      if (!attempt) {
        // Missing provenance needs investigation; starting an unrelated worker
        // would conceal the lost artifact and spend the user's budget again.
        await tx`UPDATE tasks SET status = 'parked', updated_at = now() WHERE id = ${task.id} AND status = 'judging'`;
        recovered.push({ taskId: task.id, projectId: task.project_id, kind: "missing_artifact" });
        continue;
      }
      const message: JudgeMessage = {
        taskId: task.id,
        projectId: task.project_id,
        wishId: task.wish_id,
        attemptId: attempt.id,
        branch: attempt.branch,
        worktreeRef: attempt.worktree_ref,
      };
      await tx`SELECT pgmq.send(${QUEUES.judge}::text, ${JSON.stringify(message)}::jsonb, 0::integer)`;
      recovered.push({ taskId: task.id, projectId: task.project_id, attemptId: attempt.id, kind: "judge_restored" });
    }
    return recovered;
  });
}
