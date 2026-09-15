import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateMergeGate,
  secretKindsInLines,
  secretPaths,
  type MergeGateInput,
} from "./merge-gate.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const NOW = new Date("2026-09-15T12:00:00Z");

// Ukázková tajemství se skládají za běhu, aby tenhle soubor sám neobsahoval nic,
// co by skener (nebo GitHub push protection) považoval za skutečný klíč.
const fakeGithubToken = ["gh", "p_", "A".repeat(36)].join("");
const fakePrivateKey = ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join("");

function base(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    headSha: HEAD,
    checkRuns: [{ name: "ci", status: "completed", conclusion: "success", headSha: HEAD }],
    combinedStatus: { state: "pending", totalCount: 0, sha: HEAD },
    mergeable: true,
    mergeableState: "clean",
    judgeApproved: true,
    changedFiles: ["src/app.ts"],
    addedLines: ["export const x = 1;"],
    repoHasWorkflows: true,
    openedAt: new Date(NOW.getTime() - 10 * 60_000),
    ownerPause: false,
    now: NOW,
    ...overrides,
  };
}

test("zelené checky pro aktuální SHA → allow", () => {
  const r = evaluateMergeGate(base());
  assert.equal(r.allow, true);
  assert.equal(r.code, "ok");
});

test("čekající check → wait, ne allow", () => {
  const r = evaluateMergeGate(
    base({ checkRuns: [{ name: "ci", status: "in_progress", conclusion: null, headSha: HEAD }] }),
  );
  assert.equal(r.allow, false);
  assert.equal(r.wait, true);
  assert.equal(r.code, "check_pending");
});

test("check pro starý SHA → deny", () => {
  const r = evaluateMergeGate(
    base({ checkRuns: [{ name: "ci", status: "completed", conclusion: "success", headSha: OLD }] }),
  );
  assert.equal(r.allow, false);
  assert.notEqual(r.wait, true);
  assert.equal(r.code, "stale_check");
});

test("combined status pro starý SHA → deny", () => {
  const r = evaluateMergeGate(base({ combinedStatus: { state: "success", totalCount: 1, sha: OLD } }));
  assert.equal(r.allow, false);
  assert.equal(r.code, "stale_check");
});

test("neúspěšný check → deny s názvem kroku", () => {
  const r = evaluateMergeGate(
    base({ checkRuns: [{ name: "test", status: "completed", conclusion: "failure", headSha: HEAD }] }),
  );
  assert.equal(r.allow, false);
  assert.equal(r.code, "check_failed");
  assert.match(r.reason ?? "", /test/);
});

test("0 checků bez workflow → allow", () => {
  const r = evaluateMergeGate(base({ checkRuns: [], repoHasWorkflows: false }));
  assert.equal(r.allow, true);
});

test("0 checků s workflow → wait (a po dvou hodinách deny)", () => {
  const waiting = evaluateMergeGate(base({ checkRuns: [] }));
  assert.equal(waiting.allow, false);
  assert.equal(waiting.wait, true);
  assert.equal(waiting.code, "checks_missing_wait");

  const late = evaluateMergeGate(
    base({ checkRuns: [], openedAt: new Date(NOW.getTime() - 3 * 60 * 60_000) }),
  );
  assert.equal(late.allow, false);
  assert.notEqual(late.wait, true);
  assert.equal(late.code, "checks_missing");
});

test("jen přeskočené joby se počítají jako žádné checky", () => {
  const r = evaluateMergeGate(
    base({ checkRuns: [{ name: "deploy", status: "completed", conclusion: "skipped", headSha: HEAD }] }),
  );
  assert.equal(r.wait, true);
});

test("tajemství v přidaných řádcích → deny", () => {
  const r = evaluateMergeGate(base({ addedLines: [`const t = "${fakeGithubToken}";`] }));
  assert.equal(r.allow, false);
  assert.equal(r.code, "secret_content");
  // Důvod NESMÍ obsahovat samotnou hodnotu.
  assert.ok(!(r.reason ?? "").includes(fakeGithubToken));
});

test("soukromý klíč v řádcích → deny", () => {
  assert.deepEqual(secretKindsInLines([fakePrivateKey]), ["soukromý klíč"]);
});

test("citlivá cesta kdekoli ve stromu → deny", () => {
  const r = evaluateMergeGate(base({ changedFiles: ["apps/web/.env.production"] }));
  assert.equal(r.allow, false);
  assert.equal(r.code, "secret_path");
  assert.deepEqual(
    secretPaths(["a/b/id_rsa", "certs/server.pem", "x/cert.p12", "deep/credentials.json", ".env", "src/ok.ts"]),
    ["a/b/id_rsa", "certs/server.pem", "x/cert.p12", "deep/credentials.json", ".env"],
  );
  // Šablony bez hodnot jsou v pořádku.
  assert.deepEqual(secretPaths([".env.example", "apps/web/.env.sample"]), []);
});

test("konflikt → deny", () => {
  assert.equal(evaluateMergeGate(base({ mergeable: false })).code, "conflict");
  assert.equal(evaluateMergeGate(base({ mergeable: null, mergeableState: "dirty" })).code, "conflict");
});

test("owner_pause → deny", () => {
  const r = evaluateMergeGate(base({ ownerPause: true }));
  assert.equal(r.allow, false);
  assert.equal(r.code, "owner_pause");
  assert.notEqual(r.wait, true);
});

test("bez schválení soudcem → deny", () => {
  assert.equal(evaluateMergeGate(base({ judgeApproved: false })).code, "judge_not_approved");
});

test("GitHub ještě počítá mergeable → wait", () => {
  const r = evaluateMergeGate(base({ mergeable: null, mergeableState: "unknown" }));
  assert.equal(r.wait, true);
  assert.equal(r.code, "mergeability_unknown");
});
