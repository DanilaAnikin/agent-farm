import assert from "node:assert/strict";
import { test } from "node:test";
import { PLANS, PLAN_ORDER, getPlan, planCaps, planKeyForPriceId } from "./plans.js";

test("getPlan defaultuje na free", () => {
  assert.equal(getPlan(undefined).key, "free");
  assert.equal(getPlan(null).key, "free");
  assert.equal(getPlan("neexistuje").key, "free");
  assert.equal(getPlan("pro").key, "pro");
});

test("PLAN_ORDER kryje všechny plány a rostou cenou", () => {
  assert.deepEqual(PLAN_ORDER, ["free", "starter", "pro", "scale"]);
  for (let i = 1; i < PLAN_ORDER.length; i++) {
    const prev = PLANS[PLAN_ORDER[i - 1]!]!;
    const cur = PLANS[PLAN_ORDER[i]!]!;
    assert.ok(cur.priceMonthlyUsd >= prev.priceMonthlyUsd);
    assert.ok(cur.monthlyCreditUsd >= prev.monthlyCreditUsd);
  }
});

test("kredit v plánu je vyšší než cena (marže na spotřebu)", () => {
  // Placené plány dávají víc kreditů než stojí (kredit = at-cost spotřeba).
  for (const key of ["starter", "pro", "scale"] as const) {
    assert.ok(PLANS[key].monthlyCreditUsd > PLANS[key].priceMonthlyUsd);
  }
});

test("planCaps bere z plánu, override má přednost", () => {
  const caps = planCaps(getPlan("pro"));
  assert.equal(caps.dailyCapUsd, PLANS.pro.dailyCapUsd);
  const over = planCaps(getPlan("pro"), { dailyCapUsd: 99 });
  assert.equal(over.dailyCapUsd, 99);
  assert.equal(over.maxWorkers, PLANS.pro.maxWorkers); // neoverridnuté zůstává
});

test("planKeyForPriceId mapuje z env", () => {
  process.env.STRIPE_PRICE_PRO = "price_test_pro_123";
  assert.equal(planKeyForPriceId("price_test_pro_123"), "pro");
  assert.equal(planKeyForPriceId("price_unknown"), null);
  delete process.env.STRIPE_PRICE_PRO;
});

test("free plán nemá placené předplatné, ostatní ano", () => {
  assert.equal(PLANS.free.stripePriceEnv, undefined);
  for (const key of ["starter", "pro", "scale"] as const) {
    assert.ok(PLANS[key].stripePriceEnv);
  }
});
