import assert from "node:assert/strict";
import { test } from "node:test";
import { SEMANTIC_FAILURE_BACKOFF_MS, SEMANTIC_MAX_FAILURES, semanticAttempt } from "./work-dedup.js";

const NOW = 1_800_000_000_000;
const limits = { callsPerDay: 60 };

test("sémantická kontrola: bez chyb a pod denním stropem se ptá", () => {
  assert.equal(semanticAttempt({ failures: 0, lastFailureAt: null, callsToday: 0, now: NOW }, limits), "call");
});

test("sémantická kontrola: po čerstvé chybě čeká (negativní cache), ne každou minutu", () => {
  const s = { failures: 1, lastFailureAt: NOW - 60_000, callsToday: 5, now: NOW };
  assert.equal(semanticAttempt(s, limits), "wait");
  assert.equal(semanticAttempt({ ...s, lastFailureAt: NOW - SEMANTIC_FAILURE_BACKOFF_MS - 1 }, limits), "call");
});

test("sémantická kontrola: po opakovaných chybách rozhodne mechanický práh", () => {
  assert.equal(
    semanticAttempt({ failures: SEMANTIC_MAX_FAILURES, lastFailureAt: NOW, callsToday: 0, now: NOW }, limits),
    "mechanical",
  );
});

test("sémantická kontrola: denní strop placených volání", () => {
  assert.equal(semanticAttempt({ failures: 0, lastFailureAt: null, callsToday: 60, now: NOW }, limits), "wait");
  assert.equal(semanticAttempt({ failures: 0, lastFailureAt: null, callsToday: 59, now: NOW }, limits), "call");
});
