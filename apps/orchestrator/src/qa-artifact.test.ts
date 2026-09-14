import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareQaWorkspace, QaArtifactError, qaInfrastructureFailure } from "./qa-artifact.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(run: (root: string, repo: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-qa-artifact-"));
  try {
    const repo = join(root, "project1"); await fs.mkdir(repo);
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    await fs.writeFile(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "baseline");
    await run(root, repo);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function branch(repo: string, task: string, path: string, content: string) {
  git(repo, "checkout", "-b", `farm/task-${task}`, "main");
  await fs.writeFile(join(repo, path), content); git(repo, "add", "."); git(repo, "commit", "-m", task);
  const commit = git(repo, "rev-parse", "HEAD"); git(repo, "checkout", "main");
  return { taskId: task, attemptId: `attempt-${task}`, branch: `farm/task-${task}`, commit };
}

test("existing repo QA verifies reviewed PR code absent from main and preserves provenance", async () => fixture(async (root, repo) => {
  const main = git(repo, "rev-parse", "HEAD");
  const reviewed = await branch(repo, "one", "guard.test.ts", "reviewed test\n");
  const qa = await prepareQaWorkspace({ workspacesRoot: root, projectId: "project1", qaRunId: "run1", existing: true, artifacts: [reviewed] });
  assert.equal(await fs.readFile(join(qa.path, "guard.test.ts"), "utf8"), "reviewed test\n");
  await assert.rejects(fs.access(join(repo, "guard.test.ts")));
  assert.equal(qa.commit, reviewed.commit); assert.deepEqual(qa.artifacts, [reviewed]);
  assert.equal(git(repo, "rev-parse", "HEAD"), main); assert.equal(git(repo, "status", "--porcelain"), "");
  await qa.cleanup(); await qa.cleanup(); await assert.rejects(fs.access(qa.path));
  assert.equal(git(repo, "rev-parse", reviewed.branch), reviewed.commit);
}));

test("independent approved tasks are composed together without moving main or source branches", async () => fixture(async (root, repo) => {
  const main = git(repo, "rev-parse", "HEAD");
  const one = await branch(repo, "one", "one.test.ts", "first reviewed test\n");
  const two = await branch(repo, "two", "two.test.ts", "second reviewed test\n");
  const qa = await prepareQaWorkspace({ workspacesRoot: root, projectId: "project1", qaRunId: "run2", existing: true, artifacts: [one, two] });
  assert.equal((await fs.readFile(join(qa.path, "one.test.ts"), "utf8")).trim(), "first reviewed test");
  assert.equal((await fs.readFile(join(qa.path, "two.test.ts"), "utf8")).trim(), "second reviewed test");
  assert.equal(qa.artifacts.length, 2);
  for (const a of [one, two]) assert.equal(git(qa.path, "merge-base", qa.commit, a.commit), a.commit);
  assert.equal(git(repo, "rev-parse", "HEAD"), main);
  assert.equal(git(repo, "rev-parse", one.branch), one.commit); assert.equal(git(repo, "rev-parse", two.branch), two.commit);
  await qa.cleanup();
}));

test("conflicting approved artifacts fail as infrastructure and clean only the QA worktree", async () => fixture(async (root, repo) => {
  const one = await branch(repo, "one", "base.txt", "change one\n");
  const two = await branch(repo, "two", "base.txt", "change two\n");
  const main = git(repo, "rev-parse", "HEAD");
  await assert.rejects(prepareQaWorkspace({ workspacesRoot: root, projectId: "project1", qaRunId: "conflict", existing: true, artifacts: [one, two] }), (error: unknown) => {
    assert.ok(error instanceof QaArtifactError); assert.equal(error.reason, "approved_artifacts_conflict"); return true;
  });
  assert.equal(git(repo, "rev-parse", "HEAD"), main); assert.equal(await fs.readFile(join(repo, "base.txt"), "utf8"), "base\n");
  await assert.rejects(fs.access(join(root, ".qa-worktrees", "qa-conflict")));
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
}));

test("missing/foreign approved refs fail closed while new repo snapshots remain supported", async () => fixture(async (root, repo) => {
  for (const artifacts of [[], [{ taskId: "one", attemptId: "attempt", branch: "main" }]]) {
    await assert.rejects(prepareQaWorkspace({ workspacesRoot: root, projectId: "project1", qaRunId: "missing", existing: true, artifacts }), QaArtifactError);
  }
  const qa = await prepareQaWorkspace({ workspacesRoot: root, projectId: "project1", qaRunId: "new", existing: false, artifacts: [] });
  assert.equal(qa.commit, git(repo, "rev-parse", "HEAD")); await qa.cleanup();
}));

test("dependency installation failures never become application failures or worker repair tasks", () => {
  assert.equal(qaInfrastructureFailure({ ok: true, installOk: false, results: [{ passed: false }] }), "QA dependency installation failed");
  assert.equal(qaInfrastructureFailure({ ok: false, installOk: true, results: [] }), "QA runner did not finish");
  assert.equal(qaInfrastructureFailure({ ok: true, installOk: true, results: [] }), "QA runner produced no scenarios");
  assert.equal(qaInfrastructureFailure({ ok: true, installOk: true, results: [{ passed: false }] }), undefined);
});
