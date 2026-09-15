import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveWishStatus } from "./wish-status";

const BEZI = { paused: false };
const STOJI = { paused: true };
const PRAZDNO = { queued: 0, running: 0, parked: 0, total: 0 };

test("active přání v pozastaveném projektu NENÍ zelené „Aktivní“", () => {
  const s = effectiveWishStatus({ status: "active" }, { status: "paused" }, BEZI, {
    queued: 5,
    running: 0,
    parked: 0,
    total: 5,
  });
  assert.equal(s.label, "Stojí (projekt pozastaven)");
  assert.equal(s.tone, "neutral");
});

test("zastavený projekt (rollout) se chová jako pozastavený", () => {
  const s = effectiveWishStatus({ status: "new" }, { status: "stopped" }, BEZI, PRAZDNO);
  assert.equal(s.label, "Stojí (projekt pozastaven)");
});

test("budget_hold → čeká na rozpočet", () => {
  const s = effectiveWishStatus({ status: "active" }, { status: "budget_hold" }, BEZI, PRAZDNO);
  assert.equal(s.label, "Čeká na rozpočet");
});

test("farma stojí → čeká na spuštění farmy (projekt má přednost)", () => {
  assert.equal(
    effectiveWishStatus({ status: "active" }, { status: "active" }, STOJI, PRAZDNO).label,
    "Čeká na spuštění farmy",
  );
  assert.equal(
    effectiveWishStatus({ status: "active" }, { status: "paused" }, STOJI, PRAZDNO).label,
    "Stojí (projekt pozastaven)",
  );
});

test("všechny úkoly zaparkované a nic ve frontě → Zablokováno (warn)", () => {
  const s = effectiveWishStatus({ status: "active" }, { status: "active" }, BEZI, {
    queued: 0,
    running: 0,
    parked: 3,
    total: 3,
  });
  assert.equal(s.label, "Zablokováno");
  assert.equal(s.tone, "warn");
});

test("něco ve frontě → Rozpracováno", () => {
  const s = effectiveWishStatus({ status: "active" }, { status: "active" }, BEZI, {
    queued: 1,
    running: 0,
    parked: 2,
    total: 3,
  });
  assert.equal(s.label, "Rozpracováno");
});

test("active bez úkolů (manažer ještě plánuje) není „Zablokováno“", () => {
  assert.equal(
    effectiveWishStatus({ status: "active" }, { status: "active" }, BEZI, PRAZDNO).label,
    "Rozpracováno",
  );
});

test("nové přání čeká na manažera", () => {
  assert.equal(
    effectiveWishStatus({ status: "new" }, { status: "active" }, BEZI, PRAZDNO).label,
    "Čeká na zpracování manažerem",
  );
});

test("konečné stavy přebijí pozastavený projekt", () => {
  assert.equal(
    effectiveWishStatus({ status: "done" }, { status: "paused" }, STOJI, PRAZDNO).label,
    "Hotovo",
  );
  const parked = effectiveWishStatus({ status: "parked" }, { status: "active" }, BEZI, PRAZDNO);
  assert.equal(parked.label, "Zaparkováno");
  // Zaparkované přání je většinou archiv, ne poplach.
  assert.equal(parked.tone, "neutral");
});
