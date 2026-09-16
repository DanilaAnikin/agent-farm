import { strict as assert } from "node:assert";
import test from "node:test";

import { EVIDENCE_MARKER, hasRepoEvidence, joinRationale, shouldSkipForPendingQueue } from "./suggestions.js";

test("plná fronta nespotřebovaných návrhů generování přeskočí", () => {
  // Přesně případ z 16. 9. 10:12: 5 návrhů leželo, strategist vyrobil 5 duplicit.
  assert.equal(shouldSkipForPendingQueue({ force: false, pendingGrounded: 5, max: 5 }), true);
});

test("neúplná fronta generování nebrání", () => {
  assert.equal(shouldSkipForPendingQueue({ force: false, pendingGrounded: 4, max: 5 }), false);
  assert.equal(shouldSkipForPendingQueue({ force: false, pendingGrounded: 0, max: 5 }), false);
});

test("idle-refill (force) branou neprochází", () => {
  // Nečinný projekt si prázdnou frontu ověřuje sám; tady by brána farmu zastavila.
  assert.equal(shouldSkipForPendingQueue({ force: true, pendingGrounded: 9, max: 5 }), false);
});

test("nesmyslný strop bránu nevypne do nekonečné smyčky ani nezablokuje", () => {
  assert.equal(shouldSkipForPendingQueue({ force: false, pendingGrounded: 0, max: 0 }), false);
  assert.equal(shouldSkipForPendingQueue({ force: false, pendingGrounded: 3, max: 0 }), false);
});

test("doklad z repozitáře se pozná podle značky", () => {
  const s = joinRationale("proč", "src/app.ts:12");
  assert.ok(s?.includes(EVIDENCE_MARKER));
  assert.equal(hasRepoEvidence(s), true);
  assert.equal(hasRepoEvidence(joinRationale("jen důvod", null)), false);
  assert.equal(hasRepoEvidence(null), false);
});
