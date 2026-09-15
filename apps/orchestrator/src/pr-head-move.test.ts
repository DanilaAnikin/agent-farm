import assert from "node:assert/strict";
import { test } from "node:test";
import { changedPatchLines, judgeHeadMove } from "./pr-head-move.js";
import type { HeadMoveCompare, HeadMoveFile, HeadMoveInput } from "./pr-head-move.js";

const sha = (c: string) => c.repeat(40);

// Větev PR: A (práce workeru, posouzená). Hlavní větev mezitím dostala M1 a M2
// (jeden rodič — squash merge). update-branch vyrobí merge commit U(A, M2).
const A = sha("a");
const M2 = sha("2");
const U = sha("u");
const X = sha("x");

const souborPosouzeny: HeadMoveFile = {
  filename: "src/app.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  sha: sha("b"),
  patch: "@@ -1,3 +1,3 @@\n kontext\n-const x = 1;\n+const x = 2;\n",
};

const judged: HeadMoveCompare = {
  commits: [{ sha: A, parents: [sha("0")] }],
  totalCommits: 1,
  files: [souborPosouzeny],
};

function input(current: Partial<HeadMoveCompare>, status = "ahead"): HeadMoveInput {
  return {
    sinceJudgedStatus: status,
    judged,
    current: {
      commits: [{ sha: A, parents: [sha("0")] }, { sha: U, parents: [A, M2] }],
      totalCommits: 2,
      // Hlavní větev změnila kontext kolem řádku — hunk hlavička i kontext se liší.
      files: [{ ...souborPosouzeny, sha: sha("c"), patch: "@@ -10,3 +10,3 @@\n jiny kontext\n-const x = 1;\n+const x = 2;\n" }],
      ...current,
    },
  };
}

test("update-branch s commitem z main o jednom rodiči je bezpečný posun", () => {
  // Commit M2 z hlavní větve má jednoho rodiče; do compare base...head se nedostane,
  // protože je v hlavní větvi. Dřívější kontrola na tomhle vždy selhala.
  assert.deepEqual(judgeHeadMove(input({})), { safe: true });
});

test("stejná hlava je bezpečná", () => {
  assert.deepEqual(judgeHeadMove(input({}, "identical")), { safe: true });
});

test("přepsaná historie (diverged) není bezpečná", () => {
  const v = judgeHeadMove(input({}, "diverged"));
  assert.equal(v.safe, false);
});

test("nový commit s jedním rodičem ve větvi PR vrací úkol k posouzení", () => {
  const v = judgeHeadMove(
    input({
      commits: [{ sha: A, parents: [sha("0")] }, { sha: X, parents: [A] }],
      totalCommits: 2,
    }),
  );
  assert.equal(v.safe, false);
});

test("merge commit z cizí větve (oba rodiče ve větvi PR) neprojde", () => {
  const cizi = sha("f");
  const v = judgeHeadMove(
    input({
      commits: [
        { sha: A, parents: [sha("0")] },
        { sha: cizi, parents: [sha("0")] },
        { sha: U, parents: [A, cizi] },
      ],
      totalCommits: 3,
    }),
  );
  assert.equal(v.safe, false);
});

test("merge commit s vlastní změnou (řešení konfliktu) neprojde", () => {
  const v = judgeHeadMove(
    input({
      files: [{ ...souborPosouzeny, sha: sha("d"), patch: "@@ -1,3 +1,3 @@\n kontext\n-const x = 1;\n+const x = 3;\n" }],
    }),
  );
  assert.equal(v.safe, false);
});

test("přidaný soubor po posunu neprojde", () => {
  const v = judgeHeadMove(
    input({
      files: [
        { ...souborPosouzeny },
        { filename: "src/extra.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" },
      ],
    }),
  );
  assert.equal(v.safe, false);
});

test("soubor bez patche projde jen se stejným blobem", () => {
  const bezPatche: HeadMoveFile = { filename: "logo.png", status: "added", additions: 0, deletions: 0, sha: sha("e") };
  const j: HeadMoveInput = {
    sinceJudgedStatus: "ahead",
    judged: { ...judged, files: [bezPatche] },
    current: {
      commits: [{ sha: A, parents: [sha("0")] }, { sha: U, parents: [A, M2] }],
      totalCommits: 2,
      files: [bezPatche],
    },
  };
  assert.deepEqual(judgeHeadMove(j), { safe: true });
  assert.equal(judgeHeadMove({ ...j, current: { ...j.current, files: [{ ...bezPatche, sha: sha("9") }] } }).safe, false);
});

test("neúplný seznam commitů se neověřuje naslepo", () => {
  assert.equal(judgeHeadMove(input({ totalCommits: 400 })).safe, false);
});

test("změněné řádky patche bez hlaviček a kontextu", () => {
  assert.deepEqual(changedPatchLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n ctx\n-old\n+new"), ["-old", "+new"]);
});
