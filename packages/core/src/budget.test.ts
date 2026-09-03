import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBudget,
  checkBudget,
  nextResetUtc,
  shouldAutoResume,
  type CapSet,
  type SpendSnapshot,
} from "./budget.js";
import { BudgetExceededError } from "./errors.js";

/** Základní stropy — vysoké, aby jednotlivé vrstvy šly testovat izolovaně. */
const caps: CapSet = {
  farmDailyCapUsd: 100,
  userDailyCapUsd: 50,
  projectDailyCapUsd: 20,
  wishBudgetUsd: 10,
};

const zero: SpendSnapshot = {
  farmTodayUsd: 0,
  userTodayUsd: 0,
  projectTodayUsd: 0,
  wishTotalUsd: 0,
};

test("checkBudget vrací null, když je vše pod stropem", () => {
  assert.equal(checkBudget(zero, caps), null);
  assert.equal(checkBudget({ ...zero, farmTodayUsd: 99 }, caps, 1), null); // přesně na stropu
});

test("checkBudget detekuje farm vrstvu", () => {
  assert.equal(checkBudget({ ...zero, farmTodayUsd: 101 }, caps), "farm");
  assert.equal(checkBudget({ ...zero, farmTodayUsd: 100 }, caps, 0.01), "farm");
});

test("checkBudget detekuje user vrstvu (farm pod stropem)", () => {
  assert.equal(checkBudget({ ...zero, userTodayUsd: 51 }, caps), "user");
});

test("checkBudget detekuje project vrstvu", () => {
  assert.equal(checkBudget({ ...zero, projectTodayUsd: 21 }, caps), "project");
});

test("checkBudget detekuje wish vrstvu", () => {
  assert.equal(checkBudget({ ...zero, wishTotalUsd: 11 }, caps), "wish");
});

test("checkBudget: farm má přednost před nižšími vrstvami", () => {
  const overAll: SpendSnapshot = {
    farmTodayUsd: 999,
    userTodayUsd: 999,
    projectTodayUsd: 999,
    wishTotalUsd: 999,
  };
  assert.equal(checkBudget(overAll, caps), "farm");
});

test("checkBudget: wish se ignoruje, když cap nebo spend chybí", () => {
  const noWishCap: CapSet = { ...caps, wishBudgetUsd: undefined };
  assert.equal(checkBudget({ ...zero, wishTotalUsd: 9999 }, noWishCap), null);
  const noWishSpend: SpendSnapshot = { ...zero, wishTotalUsd: undefined };
  assert.equal(checkBudget(noWishSpend, caps), null);
});

test("checkBudget zahrnuje pendingUsd", () => {
  assert.equal(checkBudget({ ...zero, projectTodayUsd: 19 }, caps, 2), "project");
  assert.equal(checkBudget({ ...zero, projectTodayUsd: 19 }, caps, 1), null);
});

test("assertBudget vyhodí BudgetExceededError se správným scope", () => {
  assert.doesNotThrow(() => assertBudget(zero, caps));
  try {
    assertBudget({ ...zero, userTodayUsd: 60 }, caps);
    assert.fail("mělo vyhodit");
  } catch (e) {
    assert.ok(e instanceof BudgetExceededError);
    assert.equal((e as BudgetExceededError).scope, "user");
    assert.equal((e as BudgetExceededError).name, "BudgetExceededError");
  }
});

test("nextResetUtc dává příští UTC půlnoc", () => {
  const now = new Date("2026-07-03T15:30:45.123Z");
  const reset = nextResetUtc(now);
  assert.equal(reset.toISOString(), "2026-07-04T00:00:00.000Z");
});

test("nextResetUtc: těsně před půlnocí → následující den", () => {
  const now = new Date("2026-07-03T23:59:59.000Z");
  assert.equal(nextResetUtc(now).toISOString(), "2026-07-04T00:00:00.000Z");
});

test("shouldAutoResume je true až po přetočení okna", () => {
  const heldSince = new Date("2026-07-03T10:00:00.000Z");
  // Před resetem (stále 3.7.) → false
  assert.equal(shouldAutoResume(heldSince, new Date("2026-07-03T23:59:59.000Z")), false);
  // Přesně na resetu (4.7. 00:00) → true
  assert.equal(shouldAutoResume(heldSince, new Date("2026-07-04T00:00:00.000Z")), true);
  // Po resetu → true
  assert.equal(shouldAutoResume(heldSince, new Date("2026-07-04T09:00:00.000Z")), true);
});

test("checkBudget: měsíční strop farmy se testuje před denním", () => {
  const monthly = { ...caps, farmMonthlyCapUsd: 20 };
  // Dnešní okno prázdné, ale měsíc vyčerpaný — projít nesmí.
  assert.equal(checkBudget({ ...zero, farmMonthUsd: 20.01 }, monthly), "farm_month");
  assert.equal(checkBudget({ ...zero, farmMonthUsd: 19.99 }, monthly, 0.05), "farm_month");
  assert.equal(checkBudget({ ...zero, farmMonthUsd: 19.9 }, monthly, 0.05), null);
});

test("checkBudget: měsíční strop má přednost před farm vrstvou", () => {
  const monthly = { ...caps, farmMonthlyCapUsd: 20 };
  assert.equal(checkBudget({ ...zero, farmMonthUsd: 999, farmTodayUsd: 999 }, monthly), "farm_month");
});

test("checkBudget: měsíční strop se ignoruje, když cap nebo spend chybí", () => {
  // Bez stropu (starší konfigurace) se chování nesmí změnit.
  assert.equal(checkBudget({ ...zero, farmMonthUsd: 9999 }, caps), null);
  assert.equal(checkBudget(zero, { ...caps, farmMonthlyCapUsd: 20 }), null);
});
