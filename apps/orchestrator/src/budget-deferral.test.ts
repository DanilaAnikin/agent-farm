import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admissionBlockedScope,
  budgetClassLabel,
  budgetWindowResetAt,
  classifyBudgetDeferral,
  classifyBudgetText,
  decideAllowanceDeferral,
  guardAdmissionReserveUsd,
  guardPeakReservationUsd,
  secondsUntilBudgetReset,
  BUDGET_RESET_MARGIN_SEC,
} from "./budget-deferral.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// --- klasifikace -----------------------------------------------------------------

test("guard daily/monthly refusals are farm_window with the right window", () => {
  assert.deepEqual(classifyBudgetText("budget: daily limit reached"), { kind: "farm_window", window: "daily", recognized: true });
  assert.deepEqual(classifyBudgetText("budget: monthly limit reached"), { kind: "farm_window", window: "monthly", recognized: true });
  // Tvar, v jakém LiteLLM vrací HTTPException z pre-call hooku.
  const proxyBody = '{"error":{"message":"budget: daily limit reached","type":"None","param":"None","code":"402"}}';
  assert.equal(classifyBudgetText(proxyBody)?.window, "daily");
});

test("guard pause and accounting refusals are farm_blocked", () => {
  for (const text of [
    "budget: farm is paused",
    "budget: accounting is not ready",
    "budget: accounting is unavailable",
    "budget: accounting unavailable; request deferred",
  ]) {
    assert.equal(classifyBudgetText(text)?.kind, "farm_blocked", text);
  }
});

test("LiteLLM key budget texts are attempt_allowance", () => {
  for (const text of [
    '{"error":"Budget has been exceeded"}',
    "Authentication Error - Budget has been exceeded! Current cost: 0.1512, Max budget: 0.15",
    "ExceededTokenBudget: Current spend for token: 0.16; Max Budget for Token: 0.15",
    '{"error":{"type":"budget_exceeded","code":"400"}}',
  ]) {
    assert.deepEqual(classifyBudgetText(text), { kind: "attempt_allowance", recognized: true }, text);
  }
  assert.equal(classifyBudgetText("context length exceeded"), null);
  assert.equal(classifyBudgetText("pilot policy: unknown model"), null);
});

test("error classification prefers the carried class, reads LlmError bodies, and maps unknown 402 conservatively", () => {
  assert.deepEqual(
    classifyBudgetDeferral({ message: "opencode prompt failed", budget: { kind: "farm_blocked", recognized: true } }),
    { kind: "farm_blocked", recognized: true },
  );
  assert.equal(classifyBudgetDeferral({ message: "LLM request failed: 402", status: 402, body: "budget: monthly limit reached" }).window, "monthly");
  const unknown = classifyBudgetDeferral({ message: "LLM request failed: 402", status: 402, body: "" });
  assert.deepEqual(unknown, { kind: "attempt_allowance", recognized: false });
  assert.equal(budgetClassLabel(unknown), "unrecognized");
  assert.equal(budgetClassLabel({ kind: "farm_window", window: "daily", recognized: true }), "farm_window:daily");
});

// --- odklad do resetu -------------------------------------------------------------

test("farm_window waits until the next UTC reset plus margin, never an hour", () => {
  const now = new Date("2026-09-15T18:12:40.500Z");
  assert.equal(budgetWindowResetAt("daily", now).toISOString(), "2026-09-16T00:00:00.000Z");
  // 5 h 47 min 19,5 s → zaokrouhleno nahoru.
  assert.equal(secondsUntilBudgetReset("daily", now), 20_840 + BUDGET_RESET_MARGIN_SEC);
  assert.equal(budgetWindowResetAt("monthly", now).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(budgetWindowResetAt("monthly", new Date("2026-12-31T23:59:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(secondsUntilBudgetReset("daily", new Date("2026-09-15T23:59:59.999Z"), 0), 1);
});

// --- rozhodnutí o parkování ---------------------------------------------------------

test("an attempt that committed new work is deferred and resets the stall count", () => {
  const prior = [{ resumeRef: A, kind: "attempt_allowance", progressed: false }, { resumeRef: A, kind: "attempt_allowance", progressed: false }];
  assert.deepEqual(decideAllowanceDeferral({ committed: true, resumeRef: B, startRef: A, prior }), { action: "defer", stalled: 0 });
  // Pokrok bez commitu ve worktree (checkpoint je jinde než start) se počítá taky.
  assert.equal(decideAllowanceDeferral({ committed: false, resumeRef: B, startRef: A, prior }).action, "defer");
});

test("no progress: two stalled deferrals are allowed, the next one parks", () => {
  const created = { resumeRef: A, kind: "attempt_allowance", progressed: true };
  const stalled = { resumeRef: A, kind: "attempt_allowance", progressed: false };
  assert.deepEqual(decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [created] }), { action: "defer", stalled: 1 });
  assert.deepEqual(decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [stalled, created] }), { action: "defer", stalled: 2 });
  assert.deepEqual(
    decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [stalled, stalled, created] }),
    { action: "park", stalled: 3, reason: "stalled" },
  );
});

test("legacy events without kind/progressed replay the production loop and park on the third stall", () => {
  // ivanweb 14.–15. 9. 2026: f8568e8… vytvořen 22:10, pak 14:59 a 16:03 bez změny SHA.
  const legacy = (ref: string) => ({ resumeRef: ref });
  const prior = [legacy(A), legacy(A), legacy(A)]; // 16:03, 14:59, 22:10
  assert.equal(decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: prior.slice(1) }).action, "defer");
  assert.deepEqual(decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior }), { action: "park", stalled: 3, reason: "stalled" });
});

test("a different checkpoint breaks the streak; farm-window stalls neither count nor break it", () => {
  const stalled = (ref: string, kind = "attempt_allowance") => ({ resumeRef: ref, kind, progressed: false });
  // Mezi odklady vznikl commit (C → A): starší řada se nepočítá.
  assert.deepEqual(
    decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [stalled(A), { resumeRef: A, progressed: true }, stalled(C), stalled(C)] }),
    { action: "defer", stalled: 2 },
  );
  // Zavřené okno farmy na stejném checkpointu úkolu nepřitíží.
  assert.deepEqual(
    decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [stalled(A, "farm_window"), stalled(A), { resumeRef: A, progressed: true }] }),
    { action: "defer", stalled: 2 },
  );
  assert.equal(
    decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior: [stalled(A), stalled(A, "farm_window"), stalled(A), { resumeRef: A, progressed: true }] }).action,
    "park",
  );
});

test("total allowance ceiling parks even a task that keeps committing", () => {
  const prior = Array.from({ length: 6 }, (_, i) => ({ resumeRef: `${i}`.repeat(40), kind: "attempt_allowance", progressed: true }));
  assert.deepEqual(decideAllowanceDeferral({ committed: true, resumeRef: B, startRef: A, prior }), { action: "park", stalled: 0, reason: "total" });
  assert.equal(decideAllowanceDeferral({ committed: true, resumeRef: B, startRef: A, prior: prior.slice(1) }).action, "defer");
});

// --- vstupní brána -----------------------------------------------------------------

test("guard peak reservation is derived from guard constants and matches observed production maximum", () => {
  const usd = guardPeakReservationUsd();
  assert.ok(Math.abs(usd - 0.20166) < 0.0001, String(usd));
  assert.ok(usd <= 0.2022);
  assert.equal(guardAdmissionReserveUsd({}), usd);
  assert.equal(guardAdmissionReserveUsd({ GUARD_ADMISSION_CONTEXT_BYTES: "nonsense" }), usd);
  assert.ok(guardAdmissionReserveUsd({ GUARD_ADMISSION_CONTEXT_BYTES: "0" }) < 0.02);
});

test("admission gate blocks farm-wide when the guard would refuse, never loosens, and spares project caps", () => {
  const caps = { farmMonthlyCapUsd: 20, farmDailyCapUsd: 0.6, userDailyCapUsd: 5, projectDailyCapUsd: 0.3 };
  const reserve = guardPeakReservationUsd();
  // Produkce 15. 9.: 0,40 + 0,15 ≤ 0,60 prošlo, hlídač pak odmítl 0,40 + 0,20.
  const spend = { farmMonthUsd: 3, farmTodayUsd: 0.41, userTodayUsd: 0.41, projectTodayUsd: 0.1 };
  assert.equal(admissionBlockedScope(spend, caps, 0.15, 0), null);
  assert.equal(admissionBlockedScope(spend, caps, 0.15, reserve), "farm");
  assert.equal(admissionBlockedScope({ ...spend, farmTodayUsd: 0.1, farmMonthUsd: 19.85 }, caps, 0.15, reserve), "farm_month");
  // Projekt: rezerva hlídače se k projektovému stropu nepřičítá (0,12 + 0,20 by jinak blokovalo).
  assert.equal(admissionBlockedScope({ ...spend, farmTodayUsd: 0.1, projectTodayUsd: 0.12 }, caps, 0.15, reserve), null);
  // Původní brána zůstává: projekt 0,16 + 0,15 > 0,30.
  assert.equal(admissionBlockedScope({ ...spend, farmTodayUsd: 0.1, projectTodayUsd: 0.16 }, caps, 0.15, reserve), "project");
  // Rezerva menší než příděl nebo nesmysl → přesně checkBudget.
  assert.equal(admissionBlockedScope({ ...spend, farmTodayUsd: 0.44 }, caps, 0.15, 0.01), null);
  assert.equal(admissionBlockedScope({ ...spend, farmTodayUsd: 0.46 }, caps, 0.15, Number.NaN), "farm");
});
