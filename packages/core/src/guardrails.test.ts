import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNextAction } from "./guardrails.js";
import { similarity, isDuplicate } from "./dedup.js";
import { checkBudget } from "./budget.js";
import { taskMachine } from "./state-machines.js";
import { isProtectedPath, deletedTestFiles } from "./harness.js";

test("budget rejection → budget_hold, ne selhání", () => {
  const r = decideNextAction({
    errorClass: "budget",
    previousOutputs: [],
    attemptsCount: 1,
    maxAttempts: 3,
    loopThreshold: 0.9,
  });
  assert.equal(r.action, "budget_hold");
});

test("reject po vyčerpání pokusů → park", () => {
  const r = decideNextAction({
    judgeVerdict: "reject",
    previousOutputs: [],
    attemptsCount: 3,
    maxAttempts: 3,
    loopThreshold: 0.9,
  });
  assert.equal(r.action, "park");
});

test("reject s volnými pokusy → requeue", () => {
  const r = decideNextAction({
    judgeVerdict: "reject",
    previousOutputs: [],
    attemptsCount: 1,
    maxAttempts: 3,
    loopThreshold: 0.9,
  });
  assert.equal(r.action, "requeue");
});

test("opakující se výstup → park (loop detection)", () => {
  const out = "Changed config migration strategy for the fourth time again";
  const r = decideNextAction({
    judgeVerdict: "reject",
    outputSummary: out,
    previousOutputs: [out],
    attemptsCount: 1,
    maxAttempts: 3,
    loopThreshold: 0.9,
  });
  assert.equal(r.action, "park");
});

test("dedup: podobné title jsou duplikát", () => {
  assert.ok(similarity("add dark mode toggle", "add dark mode toggle to settings") > 0.5);
  assert.ok(isDuplicate("add dark mode", ["ADD dark mode!"], 0.85));
});

test("state machine: neplatný přechod vyhodí", () => {
  assert.throws(() => taskMachine.assert("done", "running"));
  assert.doesNotThrow(() => taskMachine.assert("queued", "running"));
});

test("budget check vrátí scope překročení", () => {
  const scope = checkBudget(
    { farmTodayUsd: 14.9, userTodayUsd: 1, projectTodayUsd: 1 },
    { farmDailyCapUsd: 15, userDailyCapUsd: 5, projectDailyCapUsd: 3 },
    0.5,
  );
  assert.equal(scope, "farm");
});

test("harness ráčna", () => {
  assert.ok(isProtectedPath("package.json"));
  assert.ok(isProtectedPath("apps/x/tsconfig.json"));
  assert.ok(!isProtectedPath("src/index.ts"));
  const del = deletedTestFiles([{ path: "src/a.test.ts", status: "deleted" }]);
  assert.equal(del.length, 1);
});
