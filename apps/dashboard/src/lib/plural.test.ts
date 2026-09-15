import assert from "node:assert/strict";
import { test } from "node:test";
import { countLabel, plural, TVARY } from "./plural";

const WORKER = TVARY.worker;
const UKOL = TVARY.ukol;

test("plural: české tři tvary pro reprezentativní počty", () => {
  assert.equal(plural(0, WORKER), "workerů");
  assert.equal(plural(1, WORKER), "worker");
  assert.equal(plural(2, WORKER), "workery");
  assert.equal(plural(4, WORKER), "workery");
  assert.equal(plural(5, WORKER), "workerů");
  assert.equal(plural(21, WORKER), "workerů");
  assert.equal(plural(101, WORKER), "workerů");
});

test("plural: 21 NENÍ jako 1 (na rozdíl od angličtiny)", () => {
  // Naivní `n === 1 ? a : b` by v UI vyrobilo „21 worker".
  assert.notEqual(plural(21, WORKER), plural(1, WORKER));
  // A 22 není jako 2: česky se říká „22 workerů", ne „22 workery".
  assert.equal(plural(22, WORKER), "workerů");
});

test("plural: desetinné číslo dostane genitiv, ne jednotné číslo", () => {
  assert.equal(plural(1.5, TVARY.hodina), "hodin");
});

test("plural: nesmyslný vstup se chová jako nula", () => {
  assert.equal(plural(Number.NaN, WORKER), "workerů");
  assert.equal(plural(Number.POSITIVE_INFINITY, WORKER), "workerů");
});

test("countLabel: číslo i tvar dohromady", () => {
  assert.equal(countLabel(0, UKOL), "0 úkolů");
  assert.equal(countLabel(1, UKOL), "1 úkol");
  assert.equal(countLabel(2, UKOL), "2 úkoly");
  assert.equal(countLabel(5, UKOL), "5 úkolů");
  assert.equal(countLabel(101, UKOL), "101 úkolů");
});

test("countLabel: tisíce se oddělují po česku", () => {
  assert.equal(countLabel(1234, UKOL).replace(/\s/g, " "), "1 234 úkolů");
});

test("přání mají všechny tři tvary stejné", () => {
  for (const n of [0, 1, 2, 5, 21]) {
    assert.equal(plural(n, TVARY.prani), "přání");
  }
});
