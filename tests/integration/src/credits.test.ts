/**
 * Test 2 — cost_ledger + creditBalance proti ŽIVÉ DB.
 *  - spent počítá jen tento měsíc (minulý měsíc se ignoruje)
 *  - allowance = kredit plánu + top-upy tohoto měsíce
 *  - remaining a ok (flip na 0)
 *  - addTopup idempotence dle stripeRef
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getSql } from "@farm/db";
import { creditBalance, addTopup, currentPeriodStartIso, getPlan } from "@farm/billing";
import { createUser, teardown } from "./helpers.js";

after(teardown);

test("creditBalance: jen tento měsíc, allowance = plán + top-upy, remaining správně", async () => {
  const userId = await createUser({ planKey: "pro" }); // monthlyCreditUsd = 150
  const plan = getPlan("pro");
  const sql = getSql();
  const period = currentPeriodStartIso();

  // Spotřeba TENTO měsíc (+1 h za period start → jistě uvnitř období).
  await sql`INSERT INTO cost_ledger (user_id, scope, cost_usd, ts)
            VALUES (${userId}, 'task', 3.0, ${period}::timestamptz + interval '1 hour')`;
  // Spotřeba MINULÝ měsíc (−1 den před period start) → NESMÍ se počítat.
  await sql`INSERT INTO cost_ledger (user_id, scope, cost_usd, ts)
            VALUES (${userId}, 'task', 99.0, ${period}::timestamptz - interval '1 day')`;
  // Grant z MINULÉHO měsíce → NESMÍ zvýšit allowance tohoto měsíce.
  await sql`INSERT INTO credit_ledger (user_id, kind, amount_usd, ts)
            VALUES (${userId}, 'grant', 500.0, ${period}::timestamptz - interval '1 day')`;

  // Top-up TENTO měsíc (přes veřejné API — ts = now()).
  const ok = await addTopup(userId, 10, `topup-${userId}`, "test top-up");
  assert.equal(ok, true, "addTopup vložil top-up");

  const bal = await creditBalance(userId);
  assert.equal(bal.planKey, "pro");
  assert.ok(Math.abs(bal.spentUsd - 3.0) < 1e-6, `spent jen tento měsíc = 3, got ${bal.spentUsd}`);
  assert.ok(
    Math.abs(bal.allowanceUsd - (plan.monthlyCreditUsd + 10)) < 1e-6,
    `allowance = 150 + 10 = 160, got ${bal.allowanceUsd}`,
  );
  assert.ok(Math.abs(bal.remainingUsd - 157.0) < 1e-6, `remaining = 157, got ${bal.remainingUsd}`);
  assert.equal(bal.ok, true, "ok=true když zbývá kredit");
});

test("creditBalance.ok flipne na false, když remaining klesne na 0", async () => {
  const userId = await createUser({ planKey: "free" }); // monthlyCreditUsd = 5
  const sql = getSql();
  const period = currentPeriodStartIso();

  // Utrať přesně celý příděl tohoto měsíce.
  await sql`INSERT INTO cost_ledger (user_id, scope, cost_usd, ts)
            VALUES (${userId}, 'task', 5.0, ${period}::timestamptz + interval '1 hour')`;

  const bal = await creditBalance(userId);
  assert.ok(Math.abs(bal.remainingUsd - 0) < 1e-6, `remaining = 0, got ${bal.remainingUsd}`);
  assert.equal(bal.ok, false, "ok=false při remaining <= 0 (ok je remaining > 0)");
});

test("addTopup je idempotentní dle stripeRef (stejný ref vloží jen jednou)", async () => {
  const userId = await createUser({ planKey: "starter" });
  const ref = `stripe-inv-${userId}`;
  const sql = getSql();

  const first = await addTopup(userId, 7, ref);
  const second = await addTopup(userId, 7, ref);
  assert.equal(first, true, "první vložení proběhlo");
  assert.equal(second, false, "druhé vložení stejného stripeRef bylo zahozeno (idempotence)");

  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM credit_ledger WHERE stripe_ref = ${ref}`;
  assert.equal(rows[0]!.n, 1, "v ledgeru je právě jeden řádek pro daný stripeRef");
});
