import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { RepositorySyncError, syncExistingRepository } from "./git-sync.js";

async function fixture(t: TestContext, branch = "main") {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-git-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin"); const local = join(root, "local");
  await fs.mkdir(origin);
  const upstream = simpleGit(origin);
  await upstream.init(); await upstream.checkoutLocalBranch(branch);
  await upstream.addConfig("user.name", "Fixture"); await upstream.addConfig("user.email", "fixture@example.test");
  await fs.writeFile(join(origin, "source.txt"), "baseline\n");
  await upstream.add("source.txt"); await upstream.commit("initial");
  await simpleGit().clone(origin, local);
  const git = simpleGit(local);
  await git.addConfig("user.name", "Fixture"); await git.addConfig("user.email", "fixture@example.test");
  const commit = async (where: string, file: string, content = "change\n") => {
    await fs.writeFile(join(where, file), content);
    await simpleGit(where).add(file); await simpleGit(where).commit(`change ${file}`);
  };
  return { origin, local, upstream, git, commit };
}

test("fast-forwards main while preserving all unrelated untracked files", async (t) => {
  const f = await fixture(t);
  for (const name of [".farm", "node_modules"]) await fs.mkdir(join(f.local, name));
  for (const name of [".farm/progress.md", ".env", "node_modules/local.txt", "notes.txt"]) {
    await fs.writeFile(join(f.local, name), "keep me\n");
  }
  await f.commit(f.origin, "new-source.txt");
  assert.equal(await syncExistingRepository(f.local), "fast_forward");
  assert.equal(await f.git.revparse(["HEAD"]), await f.upstream.revparse(["HEAD"]));
  assert.equal(await fs.readFile(join(f.local, ".env"), "utf8"), "keep me\n");
  assert.equal(await fs.readFile(join(f.local, "notes.txt"), "utf8"), "keep me\n");
  assert.equal(await syncExistingRepository(f.local), "current");
});

test("supports master and preserves locally accepted commits ahead of origin", async (t) => {
  const f = await fixture(t, "master");
  await f.commit(f.local, "accepted.txt");
  const before = await f.git.revparse(["HEAD"]);
  assert.equal(await syncExistingRepository(f.local), "local_ahead");
  assert.equal(await f.git.revparse(["HEAD"]), before);
});

test("divergence is explicit and never resets or merges local commits", async (t) => {
  const f = await fixture(t);
  await f.commit(f.local, "local.txt"); await f.commit(f.origin, "remote.txt");
  const before = await f.git.revparse(["HEAD"]);
  await assert.rejects(syncExistingRepository(f.local), (e: unknown) => e instanceof RepositorySyncError && e.reason === "diverged");
  assert.equal(await f.git.revparse(["HEAD"]), before);
  assert.equal(await fs.readFile(join(f.local, "local.txt"), "utf8"), "change\n");
});

test("dirty tracked index and worktree block sync without changing edits", async (t) => {
  const f = await fixture(t);
  await f.commit(f.origin, "remote.txt");
  await fs.writeFile(join(f.local, "source.txt"), "uncommitted\n");
  for (const staged of [false, true]) {
    if (staged) await f.git.add("source.txt");
    await assert.rejects(syncExistingRepository(f.local), (e: unknown) => e instanceof RepositorySyncError && e.reason === "dirty");
    assert.equal(await fs.readFile(join(f.local, "source.txt"), "utf8"), "uncommitted\n");
  }
});

test("an untracked collision is preserved when ff-only refuses checkout", async (t) => {
  const f = await fixture(t);
  await f.commit(f.origin, "collision.txt", "remote\n");
  await fs.writeFile(join(f.local, "collision.txt"), "local untracked\n");
  const before = await f.git.revparse(["HEAD"]);
  await assert.rejects(syncExistingRepository(f.local), (e: unknown) => e instanceof RepositorySyncError && e.reason === "fast_forward_failed");
  assert.equal(await f.git.revparse(["HEAD"]), before);
  assert.equal(await fs.readFile(join(f.local, "collision.txt"), "utf8"), "local untracked\n");
});

test("fetch failures expose only a stable category, never remote credentials or raw git stderr", async (t) => {
  const f = await fixture(t);
  await f.git.remote(["set-url", "origin", join(f.origin, "missing-secret-test-value")]);
  await assert.rejects(syncExistingRepository(f.local), (error: unknown) => {
    assert.ok(error instanceof RepositorySyncError);
    assert.equal(error.reason, "fetch_failed");
    assert.doesNotMatch(String(error), /secret-test-value/);
    assert.equal(error.cause, undefined);
    return true;
  });
});
