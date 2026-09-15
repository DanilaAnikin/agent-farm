import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionSummary, parseDecision } from "./suggestion-decisions";

test("converted je zadáno do projektu", () => {
  const d = parseDecision("converted", "converted");
  assert.equal(d.outcome, "assigned");
  assert.equal(d.label, "Zadáno → přání");
});

test("duplicita s id původního přání", () => {
  const d = parseDecision("dismissed", "duplicate:3f0c1a2b-1111-4222-8333-444455556666");
  assert.equal(d.kind, "duplicate");
  assert.equal(d.refWishId, "3f0c1a2b-1111-4222-8333-444455556666");
  assert.equal(d.detail, null);
});

test("aliasy a volný doplněk důvodu", () => {
  const d = parseDecision("dismissed", "not_grounded: repo nemá Next.js");
  assert.equal(d.kind, "not_in_repo");
  assert.equal(d.detail, "repo nemá Next.js");
  assert.equal(parseDecision("dismissed", "no_project").kind, "cross_project");
  assert.equal(parseDecision("dismissed", "PROJECT_PAUSED").kind, "project_paused");
});

test("kódy z orchestrátoru a Telegramu mají vlastní popisek", () => {
  // intake zapisuje no_project/cross_project/project_paused/duplicate, Telegram owner_dismissed
  assert.equal(parseDecision("dismissed", "owner_dismissed").label, "Zahozeno majitelem");
  assert.equal(parseDecision("dismissed", "cross_project").label, "Zahozeno: napříč projekty");
  assert.equal(parseDecision("dismissed", "duplicate").outcome, "dropped");
});

test("neznámý nebo chybějící důvod se nerozbije", () => {
  assert.equal(parseDecision("dismissed", null).label, "Zahozeno");
  assert.equal(parseDecision("dismissed", "neco_noveho").kind, "dismissed_other");
});

test("souhrn za 7 dní s českými tvary", () => {
  assert.equal(
    decisionSummary({ assigned: 2, dropped: 31, duplicate: 25, notInRepo: 6, projectPaused: 0, crossProject: 0 }),
    "2 zadány · 31 zahozeno (25 duplicit, 6 mimo repozitář)",
  );
  assert.equal(
    decisionSummary({ assigned: 1, dropped: 0, duplicate: 0, notInRepo: 0, projectPaused: 0, crossProject: 0 }),
    "1 zadán · 0 zahozeno",
  );
  assert.equal(
    decisionSummary({ assigned: 0, dropped: 3, duplicate: 3, notInRepo: 0, projectPaused: 0, crossProject: 0 }),
    "0 zadáno · 3 zahozeny (3 duplicity)",
  );
});
