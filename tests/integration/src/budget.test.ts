/**
 * Test 7 — budget/credit gate proti REÁLNÝM součtům cost_ledger.
 * checkBudget dostane snapshot spočtený SUM(cost_ledger) za dnešek a vrstvené
 * stropy; vrátí scope, který by přidání pendingUsd překročilo (budget-hold-worthy),
 * nebo null. Pořadí kontrol: farm → user → project → wish.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSql } from "@farm/db";
import { checkBudget } from "@farm/core";
import { createUser, createProject, teardown } from "./helpers.js";

after(teardown);

/** Reálné dnešní součty z cost_ledger. */
async function spendToday(userId: string, projectId: string): Promise<{ user: number; project: number }> {
  const sql = getSql();
  const u = await sql<{ s: number }[]>`
    SELECT COALESCE(sum(cost_usd), 0)::float8 AS s FROM cost_ledger
    WHERE user_id = ${userId} AND ts >= date_trunc('day', now())`;
  const p = await sql<{ s: number }[]>`
    SELECT COALESCE(sum(cost_usd), 0)::float8 AS s FROM cost_ledger
    WHERE project_id = ${projectId} AND ts >= date_trunc('day', now())`;
  return { user: Number(u[0]!.s), project: Number(p[0]!.s) };
}

test("checkBudget detekuje překročení project scope z reálných součtů", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const sql = getSql();

  // Dnešní spotřeba projektu = 2.9 (dva reálné řádky).
  await sql`INSERT INTO cost_ledger (user_id, project_id, scope, cost_usd)
            VALUES (${userId}, ${projectId}, 'attempt', 1.4),
                   (${userId}, ${projectId}, 'attempt', 1.5)`;

  const spend = await spendToday(userId, projectId);
  assert.ok(Math.abs(spend.project - 2.9) < 1e-6, `projektová spotřeba = 2.9, got ${spend.project}`);

  const caps = {
    farmDailyCapUsd: 1e9, // farm/user nastaveny vysoko → netripnou první
    userDailyCapUsd: 1e9,
    projectDailyCapUsd: 3,
  };
  const snapshot = { farmTodayUsd: spend.project, userTodayUsd: spend.user, projectTodayUsd: spend.project };

  // 2.9 + 0.6 = 3.5 > 3 → project scope (budget-hold-worthy).
  assert.equal(checkBudget(snapshot, caps, 0.6), "project", "překročení projektového stropu");
  // 2.9 + 0.05 = 2.95 < 3 → v pořádku.
  assert.equal(checkBudget(snapshot, caps, 0.05), null, "pod stropem → žádný budget hold");
});

test("checkBudget respektuje pořadí vrstev (user scope tripne dřív než project)", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const sql = getSql();

  await sql`INSERT INTO cost_ledger (user_id, project_id, scope, cost_usd)
            VALUES (${userId}, ${projectId}, 'attempt', 2.9)`;

  const spend = await spendToday(userId, projectId);
  const caps = {
    farmDailyCapUsd: 1e9,
    userDailyCapUsd: 2.5, // user strop pod dnešní spotřebou
    projectDailyCapUsd: 3,
  };
  const snapshot = { farmTodayUsd: 0, userTodayUsd: spend.user, projectTodayUsd: spend.project };

  // user: 2.9 > 2.5 → 'user' (dřív než project by tripnul).
  assert.equal(checkBudget(snapshot, caps, 0), "user", "user scope se vyhodnotí před project");
});
