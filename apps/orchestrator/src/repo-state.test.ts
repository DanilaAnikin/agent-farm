import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  IDENTITY_MAX_AGE_MS,
  buildProjectIdentity,
  gatherRepoState,
  identityRefreshedAt,
  isIdentityStale,
  packageFacts,
  readProjectIdentity,
  readmeDeploySection,
  readmeIntro,
} from "./repo-state.js";

const README = [
  "# Ripieno",
  "",
  "Platforma pro orchestraci týmů AI agentů. Monorepo (pnpm + Turbo), engine v apps/engine.",
  "",
  "## Instalace",
  "pnpm install",
  "",
  "## Nasazení",
  "Běží na vlastním serveru přes Dokploy (Docker), databáze Postgres.",
  "### Proměnné",
  "DATABASE_URL",
  "",
  "## Licence",
  "MIT",
].join("\n");

test("identita: úvod README končí druhým nadpisem a sekce nasazení se najde i česky", () => {
  const intro = readmeIntro(README);
  assert.match(intro, /orchestraci týmů AI agentů/);
  assert.doesNotMatch(intro, /Instalace/);
  const deploy = readmeDeploySection(README);
  assert.match(deploy, /Dokploy/);
  assert.match(deploy, /Proměnné/); // podsekce patří k nasazení
  assert.doesNotMatch(deploy, /Licence/);
  assert.equal(readmeDeploySection("# X\nbez sekce"), "");
  assert.ok(readmeIntro("# X\n" + "a".repeat(5000)).length <= 1500);
});

test("identita: package.json fakta a nevalidní JSON", () => {
  assert.equal(
    packageFacts(JSON.stringify({ name: "ripieno", description: "AI týmy", workspaces: ["apps/*"], packageManager: "pnpm@9.15.0" })),
    "package.json: name=ripieno; description=AI týmy; workspaces=apps/*; packageManager=pnpm@9.15.0",
  );
  assert.match(packageFacts(JSON.stringify({ name: "x", workspaces: { packages: ["packages/*"] } }))!, /packages\/\*/);
  assert.equal(packageFacts("{nevalidní"), null);
  assert.equal(packageFacts("{}"), null);
});

test("identita: hlavička nese čas ověření a obnovuje se nejvýš 1× týdně", () => {
  const now = new Date("2026-09-15T10:00:00.000Z");
  const identity = buildProjectIdentity({ readme: README, packageJson: JSON.stringify({ name: "ripieno" }), now })!;
  assert.match(identity, /^OVĚŘENÁ IDENTITA PROJEKTU/);
  assert.equal(identityRefreshedAt(identity)?.toISOString(), now.toISOString());
  assert.equal(isIdentityStale(identity, new Date(now.getTime() + IDENTITY_MAX_AGE_MS - 1)), false);
  assert.equal(isIdentityStale(identity, new Date(now.getTime() + IDENTITY_MAX_AGE_MS)), true);
  assert.equal(isIdentityStale(null, now), true);
  assert.equal(isIdentityStale("ručně psaná identita bez hlavičky", now), true);
  assert.equal(buildProjectIdentity({ readme: "", packageJson: null, now }), null);
});

test("identita se čte z checkoutu a nečte .env", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "p"), { recursive: true });
  await fs.writeFile(join(root, "p", "README.md"), README);
  await fs.writeFile(join(root, "p", "package.json"), JSON.stringify({ name: "ripieno" }));
  await fs.writeFile(join(root, "p", ".env"), "SECRET=must-not-leak\n");
  const identity = await readProjectIdentity("p", root);
  assert.match(identity!, /name=ripieno/);
  assert.match(identity!, /Dokploy/);
  assert.doesNotMatch(identity!, /must-not-leak/);
  assert.equal(await readProjectIdentity("chybi", root), null);
});

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
