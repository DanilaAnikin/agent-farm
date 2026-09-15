import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHealth, farmRunDecision, isGuardIdleReason, redactSecrets } from "./farm-guard.js";

test("farmRunDecision: připravený hlídač → běž", () => {
  assert.deepEqual(farmRunDecision({ required: true, ready: true }), { run: true });
});

test("farmRunDecision: ready=false → stop guard_not_ready", () => {
  const d = farmRunDecision({ required: true, ready: false });
  assert.equal(d.run, false);
  assert.equal(d.run === false && d.reason, "guard_not_ready");
  assert.equal(d.run === false && d.marker, "guard_not_ready");
});

test("farmRunDecision: výjimka při čtení → stop guard_unreachable (i když ready vypadá dobře)", () => {
  const d = farmRunDecision({ required: true, ready: null, error: "connection refused" });
  assert.equal(d.run === false && d.reason, "guard_unreachable");
  const d2 = farmRunDecision({ required: true, ready: true, error: "invalid totals" });
  assert.equal(d2.run === false && d2.reason, "guard_unreachable");
});

test("farmRunDecision: ready=null u povinného hlídače je fail closed", () => {
  const d = farmRunDecision({ required: true, ready: null });
  assert.equal(d.run === false && d.reason, "guard_unreachable");
});

test("farmRunDecision: ready=null bez FARM_BUDGET_GUARD_REQUIRED → běž", () => {
  assert.deepEqual(farmRunDecision({ required: false, ready: null }), { run: true });
  assert.deepEqual(farmRunDecision({ required: false, ready: null, error: "relation does not exist" }), { run: true });
});

test("farmRunDecision: vyčerpaný strop → stop budget_cap s textem markeru", () => {
  const d = farmRunDecision({ required: true, ready: true, budgetBlock: "den: 0.61/0.60 USD" });
  assert.equal(d.run === false && d.reason, "budget_cap");
  assert.equal(d.run === false && d.marker, "den: 0.61/0.60 USD");
  // Nepřipravený hlídač má přednost před stropem — je to tvrdší a přesnější důvod.
  const d2 = farmRunDecision({ required: true, ready: false, budgetBlock: "den: 0.61/0.60 USD" });
  assert.equal(d2.run === false && d2.reason, "guard_not_ready");
});

test("isGuardIdleReason rozliší hlídač od stropu", () => {
  assert.equal(isGuardIdleReason("guard_not_ready"), true);
  assert.equal(isGuardIdleReason("guard_unreachable"), true);
  assert.equal(isGuardIdleReason("budget_cap"), false);
});

test("agentHealth: živí, pracující a zaseklí agenti", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const h = agentHealth(
    [
      { status: "busy", lastHeartbeat: ago(30_000) }, // pracuje
      { status: "idle", lastHeartbeat: ago(60_000) }, // živý manager
      { status: "busy", lastHeartbeat: ago(10 * 60_000) }, // zaseklý
      { status: "idle", lastHeartbeat: ago(4 * 60_000).toISOString() }, // zaseklý (string)
      { status: "dead", lastHeartbeat: ago(48 * 3600_000) }, // dávno ukončený → nikam
      { status: "busy", lastHeartbeat: null }, // bez tepu → zaseklý
    ],
    now,
  );
  assert.deepEqual(h, { live: 2, working: 1, stalled: 3 });
});

test("agentHealth: prázdná flotila", () => {
  assert.deepEqual(agentHealth([], Date.now()), { live: 0, working: 0, stalled: 0 });
});

test("agentHealth: tep přesně na prahu už není živý", () => {
  const now = 1_000_000_000;
  const h = agentHealth([{ status: "busy", lastHeartbeat: new Date(now - 3 * 60_000) }], now);
  assert.deepEqual(h, { live: 0, working: 0, stalled: 1 });
});

test("redactSecrets: odstraní předaný token i známé tvary a zkrátí", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const msg = `HttpError: Bad credentials for ${token} at https://x-access-token:secret123@github.com/a/b`;
  const out = redactSecrets(msg, [token]);
  assert.ok(!out.includes(token));
  assert.ok(!out.includes("secret123"));
  assert.ok(out.includes("[skryto]"));
  assert.ok(!redactSecrets("token github_pat_11ABCDEFG0123456789_abcdefghijklmnop").includes("github_pat_"));
  assert.ok(!redactSecrets("Authorization: token abcdef123456").includes("abcdef123456"));
  assert.equal(redactSecrets("x".repeat(500)).length, 200);
});
