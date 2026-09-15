import assert from "node:assert/strict";
import { test } from "node:test";
import type { getSql } from "@farm/db";
import { recoverOrphanedJudging } from "./judging-recovery.js";

interface Task { id: string; project_id: string; wish_id: string | null; status: string; }
interface Attempt { id: string; branch: string; worktree_ref: string; }
interface Queued { message: { taskId: string }; vt: number; }

function mockDatabase(options: { queued?: Queued[]; attempt?: Attempt | null; failSend?: boolean } = {}) {
  const task: Task = { id: "task-1", project_id: "project-1", wish_id: "wish-1", status: "judging" };
  const attempt = options.attempt === undefined
    ? { id: "paid-attempt", branch: "farm/task-1-paid", worktree_ref: "/work/paid-attempt" }
    : options.attempt;
  const queue = [...(options.queued ?? [])];
  const sent: unknown[] = [];
  let transactions = 0;
  let attemptReads = 0;
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM tasks t")) {
      // Explicitly protect the SQL regression: querying only visible messages is
      // wrong even when a mock happens to return an empty set of orphaned tasks.
      assert.match(query, /pgmq\.q_q_judge/);
      assert.match(query, /NOT EXISTS/);
      assert.doesNotMatch(query, /\bvt\b|pgmq\.read/);
      assert.match(query, /FOR UPDATE OF t SKIP LOCKED/);
      assert.equal(values[0], 900_000);
      return task.status === "judging" && !queue.some((q) => q.message.taskId === task.id) ? [task] : [];
    }
    if (query.includes("FROM attempts")) {
      attemptReads++;
      assert.match(query, /status = 'running'/);
      assert.match(query, /ORDER BY started_at DESC/);
      assert.match(query, /branch IS NOT NULL/);
      assert.match(query, /worktree_ref IS NOT NULL/);
      assert.deepEqual(values, [task.id]);
      return attempt ? [attempt] : [];
    }
    if (query.includes("pgmq.send")) {
      assert.equal(values[0], "q_judge");
      if (options.failSend) throw new Error("queue temporarily unavailable");
      const message = JSON.parse(values[1] as string);
      sent.push(message);
      queue.push({ message, vt: 0 });
      return [];
    }
    if (query.includes("UPDATE tasks")) {
      assert.match(query, /status = 'parked'/);
      assert.doesNotMatch(query, /status = 'queued'/);
      task.status = "parked";
      return [];
    }
    throw new Error(`Unexpected recovery query: ${query}`);
  };
  const sql = { begin: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    transactions++;
    return callback(tx);
  } } as unknown as ReturnType<typeof getSql>;
  return { sql, task, sent, attempt, counts: () => ({ transactions, attemptReads }) };
}

test("existing visible, claimed and budget-delayed judge messages all preserve paid work", async () => {
  for (const vt of [0, Date.now() + 40 * 60_000, Date.now() + 24 * 60 * 60_000]) {
    const db = mockDatabase({ queued: [{ message: { taskId: "task-1" }, vt }] });
    assert.deepEqual(await recoverOrphanedJudging(900_000, db.sql), []);
    assert.equal(db.task.status, "judging");
    assert.equal(db.sent.length, 0);
    assert.equal(db.counts().attemptReads, 0);
  }
});

test("lost message restores the same attempt, branch and worktree directly into q_judge", async () => {
  const db = mockDatabase();
  assert.deepEqual(await recoverOrphanedJudging(900_000, db.sql), [{
    taskId: "task-1", projectId: "project-1", attemptId: "paid-attempt", kind: "judge_restored",
  }]);
  assert.deepEqual(db.sent, [{
    taskId: "task-1", projectId: "project-1", wishId: "wish-1", attemptId: "paid-attempt",
    branch: "farm/task-1-paid", worktreeRef: "/work/paid-attempt",
  }]);
  assert.equal(db.task.status, "judging");
  assert.equal(db.counts().transactions, 1);
  // A second reconciliation observes the durable message and does not duplicate.
  assert.deepEqual(await recoverOrphanedJudging(900_000, db.sql), []);
  assert.equal(db.sent.length, 1);
});

test("other tasks' queue messages cannot hide an orphaned paid attempt", async () => {
  const db = mockDatabase({ queued: [{ message: { taskId: "other-task" }, vt: Date.now() + 86400_000 }] });
  assert.equal((await recoverOrphanedJudging(900_000, db.sql))[0]?.kind, "judge_restored");
});

test("missing attempt provenance parks once and never restarts a paid worker", async () => {
  const db = mockDatabase({ attempt: null });
  assert.deepEqual(await recoverOrphanedJudging(900_000, db.sql), [{
    taskId: "task-1", projectId: "project-1", kind: "missing_artifact",
  }]);
  assert.equal(db.task.status, "parked");
  assert.equal(db.sent.length, 0);
  assert.deepEqual(await recoverOrphanedJudging(900_000, db.sql), []);
});

test("queue failure leaves the paid attempt judging and reports no false recovery", async () => {
  const db = mockDatabase({ failSend: true });
  await assert.rejects(recoverOrphanedJudging(900_000, db.sql), /queue temporarily unavailable/);
  assert.equal(db.task.status, "judging");
  assert.equal(db.sent.length, 0);
});
