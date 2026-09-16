import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRepoFacts, manifestFingerprint } from "@farm/core";
import { collectRepoSnapshot } from "./repo-snapshot.js";

/** Vyrobí dočasné fixture repo ze zadaných souborů. */
async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "farm-snapshot-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await fs.mkdir(join(full, ".."), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

test("Node repo: přečtou se manifesty, lockfile jen velikostí a .env se nečte NIKDY", async () => {
  const root = await fixtureRepo({
    "package.json": JSON.stringify({ name: "web", packageManager: "npm@10.0.0", scripts: { dev: "next dev", build: "next build" } }),
    "package-lock.json": "{".padEnd(5000, " ") + "}",
    ".env.example": "NEXT_PUBLIC_URL=http://localhost:3000\n",
    ".env": "NEXT_PUBLIC_URL=https://produkce.example\nSECRET_KEY=opravdove-tajemstvi\n",
    "README.md": "# web\n\n## Getting started\n\nnpm ci && npm run dev\n",
    ".github/workflows/ci.yml": "jobs:\n  ci:\n    steps:\n      - run: npm ci --ignore-scripts\n      - run: npm test\n",
    "node_modules/leftpad/package.json": JSON.stringify({ name: "leftpad" }),
    "src/page.tsx": "export default function Page() { return null; }",
  });
  try {
    const snapshot = await collectRepoSnapshot(root);

    assert.ok(snapshot.files["package.json"], "kořenový package.json se čte");
    assert.ok(snapshot.files[".env.example"], ".env.example se čte (jen názvy proměnných)");
    assert.equal(snapshot.files[".env"], undefined, ".env se nesmí číst");
    assert.doesNotMatch(JSON.stringify(snapshot.files), /opravdove-tajemstvi/);
    assert.equal(snapshot.files["package-lock.json"], undefined, "lockfile se nečte");
    assert.ok((snapshot.sizes?.["package-lock.json"] ?? 0) > 0, "lockfile se jen změří");
    assert.ok(
      !snapshot.paths.some((p) => p.startsWith("node_modules/")),
      "node_modules se vůbec neprochází",
    );
    assert.ok(snapshot.paths.includes("src/page.tsx"), "zdrojové soubory zůstávají v seznamu cest");

    const facts = buildRepoFacts(snapshot);
    assert.equal(facts.packageManager, "npm", "npm repo se nesmí tvářit jako pnpm");
    assert.deepEqual(facts.envVarNames, ["NEXT_PUBLIC_URL"]);
    assert.ok(facts.ciCommands.some((c) => c.check === "install" && c.command.startsWith("npm ci")));
    assert.match(facts.readmeRun, /npm ci/);
    assert.ok(manifestFingerprint(snapshot));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Python a Go repo: rozpoznají se bez package.json", async () => {
  const python = await fixtureRepo({
    "pyproject.toml": '[project]\nname = "svc"\n',
    "requirements.txt": "fastapi\n",
    Makefile: "test:\n\tpytest -q\n",
  });
  const go = await fixtureRepo({
    "go.mod": "module example.com/svc\n\ngo 1.23\n",
    "go.sum": "example.com/x v1.0.0 h1:abc=\n",
    Dockerfile: "FROM golang:1.23\nEXPOSE 8080\n",
  });
  try {
    const pythonFacts = buildRepoFacts(await collectRepoSnapshot(python));
    assert.ok(pythonFacts.languages.includes("python"));
    assert.equal(pythonFacts.packageManager, null);
    assert.deepEqual(pythonFacts.makeTargets, ["test"]);

    const goSnapshot = await collectRepoSnapshot(go);
    const goFacts = buildRepoFacts(goSnapshot);
    assert.ok(goFacts.languages.includes("go"));
    assert.deepEqual(goFacts.dockerExpose, [8080]);
    assert.equal(goSnapshot.files["go.sum"], undefined, "go.sum je lockfile — jen velikost");
  } finally {
    await fs.rm(python, { recursive: true, force: true });
    await fs.rm(go, { recursive: true, force: true });
  }
});

test("docker-compose služby se načtou i z podadresáře", async () => {
  const root = await fixtureRepo({
    "package.json": JSON.stringify({ name: "app", scripts: { dev: "vite --port 5173" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "docker/docker-compose.dev.yml": [
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "    ports:",
      '      - "5432:5432"',
      "  redis:",
      "    image: redis:7",
    ].join("\n"),
  });
  try {
    const facts = buildRepoFacts(await collectRepoSnapshot(root));
    assert.deepEqual(
      facts.services.map((s) => s.kind),
      ["postgres", "redis"],
    );
    assert.ok(facts.ports.includes(5432));
    assert.ok(facts.ports.includes(5173), "port z dev skriptu se rozpozná");
    assert.equal(facts.packageManager, "pnpm");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repo bez manifestů nemá otisk — není co zkoumat", async () => {
  const root = await fixtureRepo({ "main.c": "int main(){return 0;}\n" });
  try {
    assert.equal(manifestFingerprint(await collectRepoSnapshot(root)), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
