/**
 * Test 5 — stavový stroj (@farm/core) perzistovaný do DB.
 * Task se řídí queued→running→judging→done přes drizzle UPDATE, každý přechod
 * hlídá taskMachine.assert. Nelegální přechod vyhodí InvalidTransitionError a
 * NEZMĚNÍ řádek v DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, tasks } from "@farm/db";
import type { TaskStatus } from "@farm/db";
import { taskMachine, InvalidTransitionError } from "@farm/core";
import { createUser, createProject, createTask, teardown } from "./helpers.js";

after(teardown);

async function currentStatus(taskId: string): Promise<TaskStatus> {
  const rows = await getDb().select({ s: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return rows[0]!.s;
}

/** Guarded přechod: přečti stav → assert → UPDATE. Assert vyhodí PŘED zápisem. */
async function transition(taskId: string, to: TaskStatus): Promise<void> {
  const from = await currentStatus(taskId);
  taskMachine.assert(from, to); // vyhodí InvalidTransitionError na nelegální přechod
  await getDb().update(tasks).set({ status: to, updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

test("legální posloupnost queued→running→judging→done se perzistuje", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const taskId = await createTask(projectId, { status: "queued" });

  await transition(taskId, "running");
  assert.equal(await currentStatus(taskId), "running");
  await transition(taskId, "judging");
  assert.equal(await currentStatus(taskId), "judging");
  await transition(taskId, "done");
  assert.equal(await currentStatus(taskId), "done", "konečný stav v DB je done");
});

test("nelegální přechod queued→done vyhodí a NEzapíše", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const taskId = await createTask(projectId, { status: "queued" });

  await assert.rejects(
    () => transition(taskId, "done"),
    InvalidTransitionError,
    "queued→done je zakázán",
  );
  assert.equal(await currentStatus(taskId), "queued", "DB stav zůstal queued (žádný zápis)");
});

test("z terminálního 'done' není žádný přechod", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const taskId = await createTask(projectId, { status: "done" });

  await assert.rejects(() => transition(taskId, "running"), InvalidTransitionError);
  await assert.rejects(() => transition(taskId, "queued"), InvalidTransitionError);
  assert.equal(await currentStatus(taskId), "done", "done zůstal done");
});
