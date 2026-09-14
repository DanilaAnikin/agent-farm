import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { gatherRepoState } from "./repo-state.js";

test("planning snapshot grounds a real pnpm monorepo in its actual runner, scripts and inherited strict mode", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-repo-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = join(root, "project");
  await fs.mkdir(join(repo, "apps/engine/src"), { recursive: true });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "ripieno", packageManager: "pnpm@9.15.0", scripts: { test: "turbo run test" } }),
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "apps/engine/package.json": JSON.stringify({ name: "@ripieno/engine", scripts: { test: "tsx --test src/*.test.ts", typecheck: "tsc --noEmit" }, devDependencies: { tsx: "^4" } }),
    "apps/engine/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "apps/engine/src/guard.ts": "export const fixture = true;\n",
    "README.md": "# Existing orchestration product\n",
    ".env": "API_KEY=must-not-enter-provider-prompt\n",
  };
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(join(repo, name), contents);
  const git = simpleGit(repo);
  await git.init();
  await git.add(Object.keys(files));
  // A checkout with an index but no commit still contains useful observed files.
  const state = await gatherRepoState("project", root);
  assert.match(state, /pnpm@9\.15\.0/);
  assert.match(state, /tsx --test src\/\*\.test\.ts/);
  assert.match(state, /"strict":true/);
  assert.match(state, /"extends":"\.\.\/\.\.\/tsconfig\.base\.json"/);
  assert.match(state, /apps\/engine\/src\/guard\.ts/);
  assert.match(state, /take precedence over stale AI-generated memory/);
  assert.match(state, /Existing orchestration product/);
  assert.doesNotMatch(state, /must-not-enter-provider-prompt/);
  assert.ok(state.length <= 16_000);
});

test("missing checkout is marked unknown rather than advertised as a new scaffold project", async () => {
  const state = await gatherRepoState("nonexistent", "/nonexistent-repo-root");
  assert.match(state, /unavailable/);
  assert.match(state, /not proof the project is new/);
});
