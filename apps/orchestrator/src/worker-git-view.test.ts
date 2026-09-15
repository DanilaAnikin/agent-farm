import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareWorkerGitView, removeWorkerGitView } from "./worker-git-view.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("isolated Git view supports HEAD/status/diff and excludes credentials and other worktrees", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-git-view-"));
  try {
    const main = join(root, "project1"), wt = join(root, "project1--task1");
    await fs.mkdir(main); git(main, "init", "-b", "main");
    git(main, "config", "user.name", "Fixture"); git(main, "config", "user.email", "fixture@example.invalid");
    await fs.writeFile(join(main, "source.txt"), "before\n"); git(main, "add", "."); git(main, "commit", "-m", "initial");
    git(main, "remote", "add", "origin", "https://user:secret-fixture@example.invalid/repo.git");
    git(main, "config", "http.extraheader", "Authorization: secret-fixture");
    git(main, "worktree", "add", "-b", "farm/task1", wt);
    const originalLink = await fs.readFile(join(wt, ".git"), "utf8");
    const head = git(wt, "rev-parse", "HEAD");
    const view = await prepareWorkerGitView(root, "project1", wt);
    const metadata = join(view.directory, "metadata");
    // The actual container uses a read-only object bind; host test supplies the same object directory.
    const env = { ...process.env, GIT_DIR: metadata, GIT_WORK_TREE: wt, GIT_OBJECT_DIRECTORY: join(main, ".git", "objects"), GIT_OPTIONAL_LOCKS: "0" };
    const sandboxGit = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", env }).trim();
    assert.equal(sandboxGit("rev-parse", "HEAD"), head);
    assert.equal(sandboxGit("branch", "--show-current"), "farm/task1");
    assert.equal(sandboxGit("status", "--porcelain"), "");
    await fs.writeFile(join(wt, "source.txt"), "after\n");
    assert.match(sandboxGit("status", "--porcelain"), /M source.txt/);
    assert.match(sandboxGit("diff"), /\+after/);
    assert.equal(await fs.readFile(join(wt, ".git"), "utf8"), originalLink);
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
    assert.equal(await fs.readFile(join(view.directory, "gitfile"), "utf8"), "gitdir: /opt/farm-git\n");
    assert.ok(view.binds.every((mount) => mount.endsWith(":ro")));
    for (const name of await fs.readdir(metadata)) assert.ok(!["logs", "worktrees", "FETCH_HEAD"].includes(name));
    assert.doesNotMatch(await fs.readFile(join(metadata, "config"), "utf8"), /secret-fixture|remote|Authorization/);
    await removeWorkerGitView(root, main); assert.equal(git(main, "rev-parse", "HEAD"), head);
    await removeWorkerGitView(root, view.directory);
    await assert.rejects(fs.access(view.directory));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a worktree from another project is rejected without disclosing Git diagnostics", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-git-view-"));
  try {
    await assert.rejects(prepareWorkerGitView(root, "../outside", root), /^Error: Worker Git metadata preparation failed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
