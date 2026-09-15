import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admissionBlockedScope,
  budgetClassLabel,
  budgetWindowResetAt,
  classifyBudgetDeferral,
  classifyBudgetText,
  decideAllowanceDeferral,
  decideFarmWindowDelay,
  farmGuardScope,
  guardAdmissionReserveUsd,
  guardPeakReservationUsd,
  oversizedParkFollowUp,
  refineBudgetClass,
  remainingStalledAttempts,
  secondsUntilBudgetReset,
  BUDGET_DEFERRAL_DELAY_SEC,
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

// --- revize: neznámý 402, přechodné odmítnutí okna, rezerva nad stropem, texty ------

test("unrecognized 402 before any step is a free farm_blocked wait, after steps it stays bounded allowance", () => {
  const unknown = { kind: "attempt_allowance", recognized: false } as const;
  assert.deepEqual(refineBudgetClass(unknown, 0), { kind: "farm_blocked", recognized: false });
  assert.deepEqual(refineBudgetClass(unknown, 3), unknown);
  // Poznaný příděl ani hlídač se neupřesňují.
  assert.deepEqual(refineBudgetClass({ kind: "attempt_allowance", recognized: true }, 0), { kind: "attempt_allowance", recognized: true });
  assert.deepEqual(refineBudgetClass({ kind: "farm_window", window: "daily", recognized: true }, 0).kind, "farm_window");
  // Druh farm_blocked se do přídělové řady nepočítá → takový odklad úkol nezaparkuje.
  const prior = [{ resumeRef: A, kind: "farm_blocked", progressed: false }, { resumeRef: A, kind: "farm_blocked", progressed: false }];
  assert.deepEqual(decideAllowanceDeferral({ committed: false, resumeRef: A, startRef: A, prior }), { action: "defer", stalled: 1 });
});

test("farm_window waits for the reset only when the orchestrator's own spend confirms it", () => {
  const now = new Date("2026-09-15T18:12:40.500Z");
  const untilDaily = secondsUntilBudgetReset("daily", now);
  // Potvrzené zavřené okno (nebo nečitelná data) → do resetu.
  assert.deepEqual(decideFarmWindowDelay({ window: "daily", now, farmScope: "farm", priorTransient: 0 }), { delaySec: untilDaily, window: "daily", transient: false });
  assert.deepEqual(decideFarmWindowDelay({ window: "daily", now, farmScope: "unknown", priorTransient: 0 }).delaySec, untilDaily);
  assert.equal(decideFarmWindowDelay({ window: "daily", now, farmScope: "farm_month", priorTransient: 0 }).window, "monthly");
  // Hláška „monthly", ale podle dat je zavřený jen den → počkat na denní reset a zkusit znovu.
  assert.equal(decideFarmWindowDelay({ window: "monthly", now, farmScope: "farm", priorTransient: 0 }).window, "daily");
  // Přechodné odmítnutí (souběžné rezervace) → krátký odklad, po dvou už do resetu.
  assert.deepEqual(decideFarmWindowDelay({ window: "daily", now, farmScope: null, priorTransient: 0 }), { delaySec: BUDGET_DEFERRAL_DELAY_SEC, window: "daily", transient: true });
  assert.equal(decideFarmWindowDelay({ window: "daily", now, farmScope: null, priorTransient: 1 }).transient, true);
  assert.deepEqual(decideFarmWindowDelay({ window: "daily", now, farmScope: null, priorTransient: 2 }), { delaySec: untilDaily, window: "daily", transient: false });
  assert.equal(decideFarmWindowDelay({ window: "daily", now, farmScope: null, priorTransient: Number.POSITIVE_INFINITY }).transient, false);
  // Krátký odklad nikdy nepřesáhne reset.
  const late = new Date("2026-09-15T23:50:00Z");
  assert.equal(decideFarmWindowDelay({ window: "daily", now: late, farmScope: null, priorTransient: 0 }).delaySec, secondsUntilBudgetReset("daily", late));
});

test("guard reserve larger than a farm cap never blocks at zero spend and never loosens checkBudget", () => {
  const zero = { farmMonthUsd: 0, farmTodayUsd: 0, userTodayUsd: 0, projectTodayUsd: 0 };
  const tight = { farmMonthlyCapUsd: 20, farmDailyCapUsd: 0.2, userDailyCapUsd: 5, projectDailyCapUsd: 0.3 };
  const reserve = guardPeakReservationUsd();
  assert.equal(admissionBlockedScope(zero, tight, 0.15, reserve), null);
  // Nesmyslně velký kontext v env (rezerva > 0,60) farmu trvale nezastaví.
  const huge = guardAdmissionReserveUsd({ GUARD_ADMISSION_CONTEXT_BYTES: "1000000" });
  assert.ok(huge > 0.6);
  assert.equal(admissionBlockedScope(zero, { ...tight, farmDailyCapUsd: 0.6 }, 0.15, huge), null);
  assert.equal(farmGuardScope({ ...zero, farmMonthUsd: 0 }, { ...tight, farmMonthlyCapUsd: 0.2 }, 0.15, reserve), null);
  // Brána zůstává aspoň tak přísná jako checkBudget(perAttempt): 0,06 + 0,15 > 0,20.
  assert.equal(admissionBlockedScope({ ...zero, farmTodayUsd: 0.06, userTodayUsd: 0.06 }, tight, 0.15, huge), "farm");
  // A se stropem 0,60 dál blokuje produkční případ (0,41 + 0,20 > 0,60) i s obří rezervou.
  assert.equal(admissionBlockedScope({ ...zero, farmTodayUsd: 0.41 }, { ...tight, farmDailyCapUsd: 0.6 }, 0.15, huge), "farm");
});

test("allowance totals come from the caller when given (reset lifecycle, no LIMIT window)", () => {
  const progressedPrior = [{ resumeRef: A, kind: "attempt_allowance", progressed: true }];
  // Po ručním retry je historie starších odkladů mimo počet → úkol se hned nezaparkuje.
  assert.equal(decideAllowanceDeferral({ committed: true, resumeRef: B, startRef: A, prior: progressedPrior, totalPrior: 1 }).action, "defer");
  // Celkový počet mimo okno 20 událostí pojistku drží.
  assert.deepEqual(decideAllowanceDeferral({ committed: true, resumeRef: B, startRef: A, prior: progressedPrior, totalPrior: 6 }), { action: "park", stalled: 0, reason: "total" });
});

test("texts: remaining attempts from one checkpoint and truthful park follow-ups", () => {
  assert.equal(remainingStalledAttempts(1, 2), 2);
  assert.equal(remainingStalledAttempts(2, 2), 1);
  assert.equal(remainingStalledAttempts(5, 2), 0);
  assert.match(oversizedParkFollowUp({ hasWish: true, outcome: "replanned", memory: true }), /přeplánuje na menší kroky/);
  assert.match(oversizedParkFollowUp({ hasWish: true, outcome: "waiting", memory: true }), /až v něm doběhne ostatní práce/);
  assert.match(oversizedParkFollowUp({ hasWish: true, outcome: "parked", memory: true }), /vyčerpalo svá přeplánování/);
  assert.equal(oversizedParkFollowUp({ hasWish: true, outcome: "failed", memory: true }), "Farma ho už neopakuje.");
  const orphan = oversizedParkFollowUp({ hasWish: false, outcome: "none", memory: false });
  assert.doesNotMatch(orphan, /přání|paměti/);
  assert.match(orphan, /menší, samostatně ověřitelné kroky/);
});
