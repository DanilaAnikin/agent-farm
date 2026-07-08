/**
 * Test 6 — dedup/refill proti REÁLNĚ uloženým titulkům.
 * Parked tasky mají dedup_key = taskDedupKey(title, done_condition). Nový
 * kandidát se poměřuje proti dedup_key existujících úkolů projektu.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSql } from "@farm/db";
import { taskDedupKey, isDuplicate, similarity } from "@farm/core";
import { createUser, createProject, createTask, teardown } from "./helpers.js";

after(teardown);

const THRESHOLD = 0.85;

/** dedup_key parked/failed úkolů projektu (mechanický refill dedup). */
async function existingDedupKeys(projectId: string): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ dedup_key: string }[]>`
    SELECT dedup_key FROM tasks
    WHERE project_id = ${projectId} AND status IN ('parked', 'failed')`;
  return rows.map((r) => r.dedup_key);
}

test("isDuplicate zachytí near-dup proti uloženým dedup_key, různé propustí", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);

  const parkedDefs: Array<[string, string]> = [
    ["Přidej JSON output flag do CLI", "cli podporuje --json"],
    ["Napiš unit testy pro parser", "parser má pokrytí testy"],
  ];
  for (const [title, done] of parkedDefs) {
    await createTask(projectId, {
      title,
      doneCondition: done,
      status: "parked",
      dedupKey: taskDedupKey(title, done),
    });
  }
  // Distraktor v jiném stavu (nesmí se do dedup množiny dostat).
  await createTask(projectId, {
    title: "Refaktoruj databázovou vrstvu",
    doneCondition: "žádné raw SQL v handlerech",
    status: "queued",
    dedupKey: taskDedupKey("Refaktoruj databázovou vrstvu", "žádné raw SQL v handlerech"),
  });

  const keys = await existingDedupKeys(projectId);
  assert.equal(keys.length, 2, "dedup množina obsahuje jen parked úkoly");

  // Kandidát skoro shodný s prvním parked úkolem → duplikát.
  const dupKey = taskDedupKey("Přidej JSON output flag do CLI", "cli podporuje --json");
  assert.equal(isDuplicate(dupKey, keys, THRESHOLD), true, "shodný kandidát je duplikát");

  // Kandidát na zcela jiné téma → není duplikát.
  const freshKey = taskDedupKey("Nasaď aplikaci na produkci", "běží na produkční doméně");
  assert.equal(isDuplicate(freshKey, keys, THRESHOLD), false, "nesouvisející kandidát projde");
});

test("similarity: shodný text = 1, nesouvisející < práh (souhlasí s pg_trgm na identitě)", async () => {
  const a = "pridej json output flag do cli";
  const b = "nasad aplikaci na produkci";

  assert.equal(similarity(a, a), 1, "identita = 1 (JS)");
  assert.ok(similarity(a, b) < THRESHOLD, "nesouvisející je pod prahem");

  // Cross-check proti pg_trgm: similarity(x,x) = 1 i v DB.
  const sql = getSql();
  const rows = await sql<{ s: number }[]>`SELECT similarity(${a}, ${a})::float8 AS s`;
  assert.ok(Math.abs(rows[0]!.s - 1) < 1e-6, "pg_trgm similarity(x,x)=1 — stejná definice identity");
});
