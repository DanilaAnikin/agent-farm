/**
 * Test 4 — tasks.dependsOn DAG proti ŽIVÉ DB.
 * Zrcadlí dotaz "ready dependents": úkol je dispatchovatelný, když VŠECHNY jeho
 * závislosti mají status 'done'. Když některá není done, není selectable.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSql } from "@farm/db";
import { createUser, createProject, createTask, teardown } from "./helpers.js";

after(teardown);

/** "Ready dependents" v daném projektu: queued úkoly s neprázdným dependsOn,
 *  jejichž VŠECHNY závislosti existují a jsou 'done'. */
async function readyDependentIds(projectId: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    SELECT t.id
    FROM tasks t
    WHERE t.project_id = ${projectId}
      AND t.status = 'queued'
      AND jsonb_array_length(t.depends_on) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(t.depends_on) AS dep(id)
        LEFT JOIN tasks d ON d.id = dep.id::uuid
        WHERE d.id IS NULL OR d.status <> 'done'
      )
  `;
  return rows.map((r) => r.id);
}

test("dependent je ready, když je jeho závislost 'done'", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);

  const root = await createTask(projectId, { title: "scaffold", status: "done", dependsOn: [] });
  const dependent = await createTask(projectId, {
    title: "feature",
    status: "queued",
    dependsOn: [root],
  });

  const ready = await readyDependentIds(projectId);
  assert.ok(ready.includes(dependent), "dependent je selectable, když root je done");
});

test("dependent NENÍ ready, dokud závislost není 'done'", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);

  const root = await createTask(projectId, { title: "scaffold", status: "running", dependsOn: [] });
  const dependent = await createTask(projectId, {
    title: "feature",
    status: "queued",
    dependsOn: [root],
  });

  let ready = await readyDependentIds(projectId);
  assert.ok(!ready.includes(dependent), "dependent NENÍ selectable, dokud root běží");

  // Dokonči root → dependent se stane ready.
  const sql = getSql();
  await sql`UPDATE tasks SET status = 'done' WHERE id = ${root}`;
  ready = await readyDependentIds(projectId);
  assert.ok(ready.includes(dependent), "po dokončení root je dependent ready");
});

test("dependent NENÍ ready, dokud je závislost jen 'merging' (PR otevřený, nesloučený)", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId, { repoMode: "existing" });

  const root = await createTask(projectId, { title: "scaffold", status: "merging", dependsOn: [] });
  const dependent = await createTask(projectId, {
    title: "feature",
    status: "queued",
    dependsOn: [root],
  });

  assert.ok(
    !(await readyDependentIds(projectId)).includes(dependent),
    "otevřený PR předchůdce nestačí — jeho kód v hlavní větvi ještě není",
  );

  // Merge smyčka potvrdí sloučení → merging → done → dependent je ready.
  const sql = getSql();
  await sql`UPDATE tasks SET status = 'done' WHERE id = ${root} AND status = 'merging'`;
  assert.ok((await readyDependentIds(projectId)).includes(dependent), "po sloučení je dependent ready");
});

test("úkol s více závislostmi je ready až když jsou VŠECHNY done", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);

  const dep1 = await createTask(projectId, { title: "dep1", status: "done", dependsOn: [] });
  const dep2 = await createTask(projectId, { title: "dep2", status: "queued", dependsOn: [] });
  const dependent = await createTask(projectId, {
    title: "join",
    status: "queued",
    dependsOn: [dep1, dep2],
  });

  assert.ok(
    !(await readyDependentIds(projectId)).includes(dependent),
    "jedna závislost není done → NENÍ ready",
  );

  const sql = getSql();
  await sql`UPDATE tasks SET status = 'done' WHERE id = ${dep2}`;
  assert.ok(
    (await readyDependentIds(projectId)).includes(dependent),
    "obě závislosti done → ready",
  );
});
