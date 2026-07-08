import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deletedTestFiles,
  isProtectedPath,
  isTestPath,
  protectedFilesTouched,
  type DiffFile,
} from "./harness.js";

test("isProtectedPath: true pro chráněné konfigurace a workflow", () => {
  const protectedPaths = [
    "package.json",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "tsconfig.json",
    "tsconfig.build.json",
    "packages/core/tsconfig.json",
    ".eslintrc",
    ".eslintrc.json",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    "vitest.config.ts",
    "vitest.config.mts",
    "jest.config.js",
    "jest.config.cjs",
    ".github/workflows/ci.yml",
    "repo/.github/workflows/deploy.yaml",
    ".farm/policy.json",
    "sub/.farm/state.json",
    ".opencode/agent.json",
    "turbo.json",
  ];
  for (const p of protectedPaths) {
    assert.equal(isProtectedPath(p), true, `${p} má být chráněný`);
  }
});

test("isProtectedPath: false pro běžné zdrojové soubory", () => {
  const normalPaths = [
    "src/index.ts",
    "src/components/Button.tsx",
    "README.md",
    "packages/core/src/budget.ts",
    "docs/package.json.md", // není přesně package.json na konci segmentu
    "notpackage.json.ts",
    "config/settings.ts",
  ];
  for (const p of normalPaths) {
    assert.equal(isProtectedPath(p), false, `${p} nemá být chráněný`);
  }
});

test("protectedFilesTouched filtruje jen chráněné soubory", () => {
  const files: DiffFile[] = [
    { path: "src/app.ts", status: "modified" },
    { path: "package.json", status: "modified" },
    { path: "README.md", status: "added" },
    { path: ".github/workflows/ci.yml", status: "modified" },
    // PŘIDANÝ chráněný soubor (scaffolding) se NEráčnuje:
    { path: "tsconfig.json", status: "added" },
  ];
  const touched = protectedFilesTouched(files);
  assert.deepEqual(
    touched.map((f) => f.path),
    ["package.json", ".github/workflows/ci.yml"],
  );
});

test("isTestPath: true pro *.test.* / *.spec.* / __tests__", () => {
  const testPaths = [
    "src/foo.test.ts",
    "src/foo.test.tsx",
    "src/foo.spec.js",
    "src/foo.spec.mjs",
    "src/foo.test.cjs",
    "packages/core/src/budget.test.ts",
    "src/__tests__/helper.ts",
    "__tests__/index.ts",
  ];
  for (const p of testPaths) {
    assert.equal(isTestPath(p), true, `${p} má být test`);
  }
});

test("isTestPath: false pro netestovací soubory", () => {
  const nonTest = ["src/foo.ts", "src/testUtils.ts", "src/spec.ts", "README.md"];
  for (const p of nonTest) {
    assert.equal(isTestPath(p), false, `${p} nemá být test`);
  }
});

test("deletedTestFiles chytí smazané testy a ignoruje ostatní", () => {
  const files: DiffFile[] = [
    { path: "src/foo.test.ts", status: "deleted" },
    { path: "src/__tests__/util.ts", status: "deleted" },
    { path: "src/bar.spec.ts", status: "deleted" },
    { path: "src/app.ts", status: "deleted" }, // netestovací smazání → ignorovat
    { path: "src/baz.test.ts", status: "modified" }, // není smazání → ignorovat
    { path: "src/new.test.ts", status: "added" }, // přidaný test → ignorovat
  ];
  const deleted = deletedTestFiles(files);
  assert.deepEqual(
    deleted.map((f) => f.path),
    ["src/foo.test.ts", "src/__tests__/util.ts", "src/bar.spec.ts"],
  );
});

test("deletedTestFiles: bez smazaných testů → prázdné pole", () => {
  const files: DiffFile[] = [
    { path: "src/app.ts", status: "deleted" },
    { path: "src/foo.test.ts", status: "modified" },
  ];
  assert.deepEqual(deletedTestFiles(files), []);
});
