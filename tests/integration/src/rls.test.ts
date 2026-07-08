/**
 * Test 3 — RLS multi-tenancy (ta velká). Proti ŽIVÉ DB, v roli `authenticated`
 * s nastaveným request.jwt.claim.sub.
 *  - Uživatel A vidí JEN svá data (projects/wishes/tasks/suggestions), NIKDY B.
 *  - Čtení profiles neselže (SECURITY DEFINER is_admin → žádná rekurze).
 *  - Admin (role='admin') vidí vše.
 *  - authenticated smí INSERT wish do SVÉHO projektu, NESMÍ do cizího.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createUser,
  createProject,
  createWish,
  createTask,
  createSuggestion,
  ensureAuthenticatedGrants,
  withAuthUser,
  teardown,
  type Sql,
} from "./helpers.js";

interface Tenant {
  userId: string;
  projectId: string;
  wishId: string;
  taskId: string;
  suggestionId: string;
}

async function makeTenant(role: "member" | "admin" = "member"): Promise<Tenant> {
  const userId = await createUser({ role });
  const projectId = await createProject(userId, { name: `proj-${role}` });
  const wishId = await createWish(projectId, { title: `wish-${userId.slice(0, 8)}` });
  const taskId = await createTask(projectId, { title: `task-${userId.slice(0, 8)}` });
  const suggestionId = await createSuggestion(userId, { projectId, title: `sug-${userId.slice(0, 8)}` });
  return { userId, projectId, wishId, taskId, suggestionId };
}

let A: Tenant;
let B: Tenant;
let admin: Tenant;

before(async () => {
  await ensureAuthenticatedGrants();
  A = await makeTenant("member");
  B = await makeTenant("member");
  admin = await makeTenant("admin");
});
after(teardown);

async function ids(tx: Sql, table: string): Promise<string[]> {
  const rows = await tx.unsafe<{ id: string }[]>(`SELECT id FROM ${table}`);
  return rows.map((r) => r.id);
}

test("A vidí své projekty a NEvidí projekty B", async () => {
  await withAuthUser(A.userId, async (tx) => {
    const seen = await ids(tx, "projects");
    assert.ok(seen.includes(A.projectId), "A vidí svůj projekt");
    assert.ok(!seen.includes(B.projectId), "A NEvidí projekt B");
    assert.equal(seen.length, 1, "A vidí právě jeden (svůj) projekt");
  });
});

test("A vidí svá wishes/tasks/suggestions a NEvidí cizí", async () => {
  await withAuthUser(A.userId, async (tx) => {
    const w = await ids(tx, "wishes");
    const t = await ids(tx, "tasks");
    const s = await ids(tx, "suggestions");
    assert.deepEqual(w, [A.wishId], "wishes: jen A");
    assert.deepEqual(t, [A.taskId], "tasks: jen A");
    assert.deepEqual(s, [A.suggestionId], "suggestions: jen A");
    assert.ok(!w.includes(B.wishId) && !t.includes(B.taskId) && !s.includes(B.suggestionId), "nic z B");
  });
});

test("čtení profiles jako authenticated neselže (žádná rekurze v is_admin)", async () => {
  await withAuthUser(A.userId, async (tx) => {
    const rows = await tx.unsafe<{ user_id: string }[]>(`SELECT user_id FROM profiles`);
    assert.deepEqual(
      rows.map((r) => r.user_id),
      [A.userId],
      "A vidí jen svůj profil, dotaz proběhl bez chyby",
    );
  });
});

test("admin (role='admin') vidí data všech uživatelů", async () => {
  await withAuthUser(admin.userId, async (tx) => {
    const projs = await ids(tx, "projects");
    assert.ok(projs.includes(A.projectId), "admin vidí projekt A");
    assert.ok(projs.includes(B.projectId), "admin vidí projekt B");
    const wishes = await ids(tx, "wishes");
    assert.ok(wishes.includes(A.wishId) && wishes.includes(B.wishId), "admin vidí wishes A i B");
  });
});

test("authenticated SMÍ INSERT wish do vlastního projektu", async () => {
  const newId = await withAuthUser(A.userId, async (tx) => {
    const rows = await tx.unsafe<{ id: string }[]>(
      `INSERT INTO wishes (project_id, title) VALUES ($1, $2) RETURNING id`,
      [A.projectId, "self-insert"],
    );
    return rows[0]!.id;
  });
  assert.ok(newId, "insert do vlastního projektu prošel");
});

test("authenticated NESMÍ INSERT wish do cizího projektu (WITH CHECK RLS)", async () => {
  await assert.rejects(
    () =>
      withAuthUser(A.userId, async (tx) => {
        await tx.unsafe(`INSERT INTO wishes (project_id, title) VALUES ($1, $2)`, [
          B.projectId,
          "hostile-insert",
        ]);
      }),
    /row-level security|violates/i,
    "RLS WITH CHECK zablokoval vložení do cizího projektu",
  );
});
