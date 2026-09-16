/**
 * Politika uvázlých přání — čisté rozhodovací funkce.
 *
 * `needsReplanSweep` vznikl 16. 9. 2026: hromadná archivace staré fronty
 * (`backlog_task_archived`) zaparkovala VŠECHNY úkoly 10 přání explain-and-act.
 * Přání zůstala `active`, ale nikdo je nikdy nevzal — parkovací cesty volají
 * `maybeReplanStuckWish` jen v okamžiku parkování a `maybeCompleteWish` potřebuje
 * dokončený úkol. Držela tím i `hasOpenWork`, takže projektu nešel zadat ani
 * jeden návrh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideStuckAction, needsReplanSweep } from "./stuck-policy.js";

test("needsReplanSweep: přání se samými zaparkovanými úkoly se přeplánuje", () => {
  assert.equal(needsReplanSweep({ runnable: 0, blocked: 5, total: 5, projectActive: true }), true);
  // Reálný případ z produkce: 4 archivované úkoly, nic spustitelného.
  assert.equal(needsReplanSweep({ runnable: 0, blocked: 4, total: 4, projectActive: true }), true);
});

test("needsReplanSweep: rozpracovanou práci nechá být", () => {
  assert.equal(needsReplanSweep({ runnable: 1, blocked: 3, total: 4, projectActive: true }), false);
  assert.equal(needsReplanSweep({ runnable: 2, blocked: 0, total: 2, projectActive: true }), false);
});

test("needsReplanSweep: přání bez úkolů patří planApprovedSpecs, ne sem", () => {
  assert.equal(needsReplanSweep({ runnable: 0, blocked: 0, total: 0, projectActive: true }), false);
});

test("needsReplanSweep: hotové přání (vše done) se nepřeplánovává", () => {
  // done úkoly nejsou ani runnable, ani blocked — sweep nemá co řešit.
  assert.equal(needsReplanSweep({ runnable: 0, blocked: 0, total: 6, projectActive: true }), false);
});

test("needsReplanSweep: neaktivní projekt se nebudí", () => {
  // ripieno/ivanweb v budget_hold a loot v paused se sweepu nesmí dotknout.
  assert.equal(needsReplanSweep({ runnable: 0, blocked: 5, total: 5, projectActive: false }), false);
});

test("decideStuckAction: pozastavený projekt jen čeká", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  assert.equal(
    decideStuckAction({
      status: "specifying",
      stuckAt: new Date("2026-09-15T00:00:00Z"),
      respecAt: null,
      projectActive: false,
      now,
    }),
    "wait",
  );
});

test("decideStuckAction: po 12 h re-specifikace, po jejím selhání uzavření", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  assert.equal(
    decideStuckAction({
      status: "specifying",
      stuckAt: new Date("2026-09-15T20:00:00Z"),
      respecAt: null,
      projectActive: true,
      now,
    }),
    "respec",
  );
  assert.equal(
    decideStuckAction({
      status: "specifying",
      stuckAt: new Date("2026-09-16T11:00:00Z"),
      respecAt: new Date("2026-09-16T10:00:00Z"),
      projectActive: true,
      now,
    }),
    "archive",
  );
});
