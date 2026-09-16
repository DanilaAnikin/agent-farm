import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCheckCommand,
  deletedTestFiles,
  deriveHarnessPlan,
  detectPackageManager,
  extractWorkflowRunCommands,
  hardenInstallCommand,
  harnessScript,
  installCommand,
  qaInstallCommand,
  isHarnessRunBroken,
  newlyBrokenChecks,
  parseHarnessOutput,
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

test("detectPackageManager: lockfile má přednost, pak pole packageManager", () => {
  assert.equal(detectPackageManager(["package.json", "package-lock.json"]), "npm");
  assert.equal(detectPackageManager(["pnpm-lock.yaml", "package-lock.json"]), "pnpm");
  assert.equal(detectPackageManager(["yarn.lock"]), "yarn");
  assert.equal(detectPackageManager(["package.json"], "pnpm@9.15.0"), "pnpm");
  assert.equal(detectPackageManager(["README.md"]), null);
});

test("installCommand: reprodukovatelná instalace podle lockfilu", () => {
  assert.equal(installCommand("npm"), "npm ci --ignore-scripts");
  assert.equal(installCommand("pnpm"), "pnpm install --frozen-lockfile --ignore-scripts");
});

test("hardenInstallCommand: instalace z receptu se dorovná na --ignore-scripts", () => {
  assert.equal(hardenInstallCommand("pnpm install"), "pnpm install --ignore-scripts");
  assert.equal(hardenInstallCommand("npm ci --ignore-scripts"), "npm ci --ignore-scripts");
  assert.equal(
    hardenInstallCommand("cd apps/web && npm install && npm run build"),
    "cd apps/web && npm install --ignore-scripts && npm run build",
  );
  assert.equal(hardenInstallCommand("make setup"), "make setup", "neinstalační příkaz se nemění");
});

test("qaInstallCommand: QA potřebuje devDependencies i lifecycle skripty", () => {
  assert.equal(qaInstallCommand("pnpm install --frozen-lockfile --ignore-scripts"), "pnpm install");
  assert.equal(qaInstallCommand("npm ci --ignore-scripts"), "npm install");
  assert.equal(qaInstallCommand("pnpm --filter @app/web install --ignore-scripts"), "pnpm --filter @app/web install");
});

test("deriveHarnessPlan: instalace z receptu jde do kontejneru jen v bezpečném tvaru", () => {
  const plan = deriveHarnessPlan({
    rootFiles: ["package.json", "package-lock.json"],
    scripts: {},
    workflowRuns: [],
    envRecipe: { install: "npm install" },
  });
  assert.equal(plan.install, "npm install --ignore-scripts");
});

test("extractWorkflowRunCommands: jednořádkové i blokové run, bez ${{ }}", () => {
  const yaml = [
    "jobs:",
    "  ci:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: pnpm install --frozen-lockfile",
    "      - name: Checks",
    "        run: |",
    "          pnpm typecheck",
    "          pnpm test",
    "      - run: echo ${{ secrets.TOKEN }}",
    "      - name: Lint",
    "        run: 'pnpm lint'",
  ].join("\n");
  assert.deepEqual(extractWorkflowRunCommands(yaml), [
    "pnpm install --frozen-lockfile",
    "pnpm typecheck",
    "pnpm test",
    "pnpm lint",
  ]);
});

test("classifyCheckCommand: rozliší kontroly a vynechá deploy", () => {
  assert.equal(classifyCheckCommand("pnpm -r build"), "build");
  assert.equal(classifyCheckCommand("npx tsc --noEmit"), "typecheck");
  assert.equal(classifyCheckCommand("pnpm --filter web test"), "tests");
  assert.equal(classifyCheckCommand("eslint ."), "lint");
  assert.equal(classifyCheckCommand("npm ci"), "install");
  assert.equal(classifyCheckCommand("pnpm run deploy"), null);
  assert.equal(classifyCheckCommand("echo hello"), null);
});

test("deriveHarnessPlan: env_recipe > workflow > skript, správce z lockfilu", () => {
  const plan = deriveHarnessPlan({
    rootFiles: ["package.json", "package-lock.json"],
    scripts: { build: "next build", test: "vitest", lint: "eslint ." },
    workflowRuns: ["npm ci", "npm run lint -- --max-warnings=0", "npx tsc --noEmit"],
    envRecipe: { commands: { test: "npm run test:ci" } },
  });
  assert.equal(plan.packageManager, "npm");
  assert.equal(plan.install, "npm ci --ignore-scripts");
  assert.equal(plan.checks.tests, "npm run test:ci");
  assert.equal(plan.source.tests, "env_recipe");
  assert.equal(plan.checks.lint, "npm run lint -- --max-warnings=0");
  assert.equal(plan.source.lint, "workflow");
  assert.equal(plan.checks.typecheck, "npx tsc --noEmit");
  assert.equal(plan.checks.build, "npm run build");
  assert.equal(plan.source.build, "script");
});

test("deriveHarnessPlan: chybějící kontrola = null (nespouští se)", () => {
  const plan = deriveHarnessPlan({ rootFiles: ["pnpm-lock.yaml"], scripts: { build: "tsc" }, workflowRuns: [] });
  assert.equal(plan.checks.build, "pnpm run build");
  assert.equal(plan.checks.tests, null);
  assert.equal(plan.source.tests, "none");
});

test("harnessScript + parseHarnessOutput: značky exit, skipped i log", () => {
  const plan = deriveHarnessPlan({ rootFiles: ["pnpm-lock.yaml"], scripts: { build: "tsc", test: "vitest" }, workflowRuns: [] });
  const script = harnessScript(plan);
  assert.match(script, /echo INSTALL_EXIT=\$INSTALL_RC/);
  // Při selhání instalace se vypíše i konec jejího logu — jinak je „INSTALL_EXIT=1"
  // bez jediného slova proč (soudce ani průzkum repozitáře z toho nic nezjistí).
  assert.match(script, /INSTALL_LOG: /);
  assert.match(script, /LINT_EXIT=0; echo LINT_SKIPPED=1/);
  const run = parseHarnessOutput(
    ["INSTALL_EXIT=0", "BUILD_EXIT=0", "TEST_EXIT=1", "TEST_LOG: expected 2 got 3", "LINT_EXIT=0", "LINT_SKIPPED=1", "TYPECHECK_EXIT=0", "TYPECHECK_SKIPPED=1"].join("\n"),
  );
  assert.equal(run.install, 0);
  assert.equal(run.exits.tests, 1);
  assert.deepEqual(run.skipped, ["lint", "typecheck"]);
  assert.equal(run.logs.tests, "expected 2 got 3");
  assert.equal(run.installLog, undefined);

  const broken = parseHarnessOutput(
    ["INSTALL_EXIT=1", "INSTALL_LOG: ERR_PNPM_OUTDATED_LOCKFILE", "INSTALL_LOG: lockfile is not up to date"].join("\n"),
  );
  assert.equal(broken.install, 1);
  assert.equal(broken.installLog, "ERR_PNPM_OUTDATED_LOCKFILE\nlockfile is not up to date");
});

test("isHarnessRunBroken: chybějící výstup nebo vše červené = porucha harnessu", () => {
  assert.equal(isHarnessRunBroken(parseHarnessOutput("")), true);
  assert.equal(
    isHarnessRunBroken(parseHarnessOutput("INSTALL_EXIT=1\nBUILD_EXIT=1\nTEST_EXIT=1\nLINT_EXIT=0\nLINT_SKIPPED=1\nTYPECHECK_EXIT=0\nTYPECHECK_SKIPPED=1")),
    true,
  );
  // Jedna padající kontrola je výsledek práce, ne porucha.
  assert.equal(
    isHarnessRunBroken(parseHarnessOutput("INSTALL_EXIT=0\nBUILD_EXIT=0\nTEST_EXIT=1\nLINT_EXIT=0\nTYPECHECK_EXIT=0")),
    false,
  );
});

test("newlyBrokenChecks: blokuje jen nově rozbité, bez baseline všechny padající", () => {
  const candidate = parseHarnessOutput("INSTALL_EXIT=0\nBUILD_EXIT=0\nTEST_EXIT=1\nLINT_EXIT=1\nTYPECHECK_EXIT=0");
  const main = parseHarnessOutput("INSTALL_EXIT=0\nBUILD_EXIT=0\nTEST_EXIT=0\nLINT_EXIT=1\nTYPECHECK_EXIT=0");
  assert.deepEqual(newlyBrokenChecks(candidate, main), ["tests"]);
  assert.deepEqual(newlyBrokenChecks(candidate, null), ["tests", "lint"]);
  const mainWithoutLint = parseHarnessOutput("INSTALL_EXIT=0\nBUILD_EXIT=0\nTEST_EXIT=0\nLINT_EXIT=0\nLINT_SKIPPED=1\nTYPECHECK_EXIT=0");
  assert.deepEqual(newlyBrokenChecks(candidate, mainWithoutLint), ["tests", "lint"]);
});

test("deletedTestFiles: bez smazaných testů → prázdné pole", () => {
  const files: DiffFile[] = [
    { path: "src/app.ts", status: "deleted" },
    { path: "src/foo.test.ts", status: "modified" },
  ];
  assert.deepEqual(deletedTestFiles(files), []);
});
