import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyGroundedQaCommands, extractExplicitQaCommands, groundQaCommands, QaCommandGroundingError } from "./qa-command-grounding.js";

async function fixture(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(join(tmpdir(), "qa-grounding-"));
  try {
    await fs.mkdir(join(workspace, "apps/engine/src"), { recursive: true });
    await fs.mkdir(join(workspace, "apps/worker/test"), { recursive: true });
    await fs.writeFile(join(workspace, "package.json"), JSON.stringify({ name: "root", scripts: { test: "turbo test", "verify-content": "node scripts/verify.mjs" }, devDependencies: { tsx: "1" } }));
    await fs.writeFile(join(workspace, "apps/engine/package.json"), JSON.stringify({ name: "@ripieno/engine", scripts: { typecheck: "tsc --noEmit" }, devDependencies: { tsx: "1" } }));
    await fs.writeFile(join(workspace, "apps/worker/package.json"), JSON.stringify({ name: "@contentgen/worker", devDependencies: { vitest: "1" } }));
    await fs.writeFile(join(workspace, "apps/engine/src/guard.test.ts"), "// fixture");
    await fs.writeFile(join(workspace, "apps/worker/test/config.test.ts"), "// fixture");
    await run(workspace);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

const criteria = [{ id: "c1", description: "Regression tests prove guardedExec contracts" }];
const ripieno = "Nový apps/engine/src/guard.test.ts ověřuje uvedené chybové a asynchronní kontrakty bez síťových závislostí. Projdou pnpm --filter @ripieno/engine exec tsx --test src/guard.test.ts a pnpm --filter @ripieno/engine typecheck. Žádná změna produkčního kódu nebo testovacího frameworku.";
const steps = ["pnpm --filter @ripieno/engine exec tsx --test src/guard.test.ts", "pnpm --filter @ripieno/engine typecheck"];

test("real no-spec Ripieno acceptance preserves exact package, test path AND typecheck", async () => fixture(async (workspacePath) => {
  const grounded = await groundQaCommands({ workspacePath, criteria, hasSpec: false, tasks: [{ id: "task", title: "guardedExec", doneCondition: ripieno }] });
  assert.equal(grounded.complete, true);
  assert.deepEqual(grounded.scenarios[0]?.steps, steps);
  assert.equal(grounded.scenarios[0]?.expect, "exit code 0 for every command");
  assert.match(grounded.promptContext, /@ripieno\/engine; scripts typecheck/);
  assert.doesNotMatch(grounded.promptContext, /turbo test|node scripts\/verify/);
}));

test("real Contentgen acceptance uses the existing Vitest runner with no new root script", async () => fixture(async (workspacePath) => {
  const grounded = await groundQaCommands({ workspacePath, criteria, hasSpec: false, tasks: [{ id: "task", title: "config", doneCondition: "Všechny kombinace mají testy. Projde pnpm --filter @contentgen/worker exec vitest run test/config.test.ts. Beze změny produkčního kódu." }] });
  assert.equal(grounded.complete, true);
  assert.deepEqual(grounded.scenarios[0]?.steps, ["pnpm --filter @contentgen/worker exec vitest run test/config.test.ts"]);
}));

test("verifyMethod and check are both grounded, and every criterion must have a check", async () => fixture(async (workspacePath) => {
  const first = { id: "test", description: "unit test", verifyMethod: steps[0] };
  const second = { id: "types", description: "typecheck", check: steps[1] };
  const all = await groundQaCommands({ workspacePath, criteria: [first, second], hasSpec: true, tasks: [] });
  assert.equal(all.complete, true);
  assert.deepEqual(all.scenarios.flatMap((item) => item.steps), steps);
  const partial = await groundQaCommands({ workspacePath, criteria: [first, { id: "ui", description: "Keyboard navigation works" }], hasSpec: true, tasks: [] });
  assert.equal(partial.complete, false);
}));

test("missing approved test, absent script or wrong workspace package prevents deterministic PASS", async () => fixture(async (workspacePath) => {
  for (const command of [
    "pnpm --filter @ripieno/engine exec tsx --test src/missing.test.ts",
    "pnpm --filter @ripieno/engine missing-script",
    "pnpm --filter @wrong/engine typecheck",
    "pnpm --filter @ripieno/engine exec vitest run src/guard.test.ts",
  ]) {
    await assert.rejects(groundQaCommands({ workspacePath, criteria: [{ ...criteria[0]!, check: command }], hasSpec: true, tasks: [] }), QaCommandGroundingError, command);
  }
  await fs.rm(join(workspacePath, "apps/engine/src/guard.test.ts"));
  await assert.rejects(groundQaCommands({ workspacePath, criteria, hasSpec: false, tasks: [{ id: "task", title: "guard", doneCondition: ripieno }] }), QaCommandGroundingError,
    "must not silently keep only the passing typecheck or invent a replacement command");
}));

test("audit task permits honest failures and sends actual commands to planner without requiring exit zero", async () => fixture(async (workspacePath) => {
  const grounded = await groundQaCommands({ workspacePath, criteria, hasSpec: false, tasks: [{
    id: "audit", title: "Audit", description: "Spusť npm run verify-content a zdokumentuj skutečný výsledek.",
    doneCondition: "Vznikne docs/audit.md s výsledky včetně případných chyb, bez vymyšlených výsledků.",
  }] });
  assert.equal(grounded.complete, false);
  assert.equal(grounded.scenarios.length, 0);
  assert.match(grounded.promptContext, /npm run verify-content/);
  assert.match(grounded.promptContext, /audit failures may be valid findings/);
}));

test("do not truncate unknown CLI arguments, shell operators or outside file paths", async () => fixture(async (workspacePath) => {
  for (const text of ["pnpm test -- guardedExec", "pnpm test || true", "pnpm test && echo yes", "pnpm test > success.txt", "pnpm test $(echo x)"]) {
    assert.deepEqual(extractExplicitQaCommands(text), [], text);
  }
  for (const path of ["../outside.test.ts", "/tmp/outside.test.ts"]) {
    await assert.rejects(groundQaCommands({ workspacePath, criteria: [{ ...criteria[0]!, check: `pnpm --filter @ripieno/engine exec tsx --test ${path}` }], hasSpec: true, tasks: [] }), QaCommandGroundingError);
  }
}));

test("partial grounding preserves unrelated UI and negative assertions with unique scenario IDs", () => {
  const generated = [
    { id: "explicit-criterion-1", name: "UI", kind: "web" as const, criterionId: "ui", steps: ["screenshot"], expect: "button visible" },
    { id: "cli", name: "guessed root test", kind: "cli" as const, criterionId: "c1", steps: ["pnpm test -- guardedExec"], expect: "exit code 0" },
    { id: "negative", name: "negative CLI", kind: "cli" as const, criterionId: "other", steps: ["node reject-invalid.js"], expect: "exit code 1" },
  ];
  const grounded = { complete: false, promptContext: "", scenarios: [{ id: "explicit-criterion-1", name: "contract", kind: "cli" as const, criterionId: "c1", steps, expect: "exit code 0" }] };
  const merged = applyGroundedQaCommands(generated, grounded);
  assert.deepEqual(merged[0], generated[0]);
  assert.deepEqual(merged[1], generated[2]);
  assert.deepEqual(merged[2]?.steps, steps);
  assert.equal(new Set(merged.map((item) => item.id)).size, merged.length);
});

test("additional output and negative assertions for the grounded criterion are never dropped", () => {
  const generated = [
    { id: "output", name: "output", kind: "cli" as const, criterionId: "c1", steps: ["node tool.js"], expect: "stdout contains 'success'" },
    { id: "negative", name: "negative", kind: "cli" as const, criterionId: "c1", steps: ["node tool.js invalid"], expect: "exit code 1" },
  ];
  const grounded = { complete: false, promptContext: "", scenarios: [{ id: "explicit", name: "contract", kind: "cli" as const, criterionId: "c1", steps, expect: "exit code 0" }] };
  assert.deepEqual(applyGroundedQaCommands(generated, grounded).slice(0, 2), generated);
});

test("manual assertions alongside a verification command cannot become a fully automated PASS", async () => fixture(async (workspacePath) => {
  const grounded = await groundQaCommands({ workspacePath, criteria: [{ id: "mixed", description: "test and manual audit", verifyMethod: "pnpm --filter @ripieno/engine typecheck; manually inspect the audit report" }], hasSpec: true, tasks: [] });
  assert.equal(grounded.complete, false);
  assert.equal(grounded.scenarios.length, 1);
}));

test("unsupported second command never leaves a partial deterministic plan", async () => fixture(async (workspacePath) => {
  const grounded = await groundQaCommands({ workspacePath, criteria, hasSpec: false, tasks: [{ id: "task", title: "guard", doneCondition: "Projdou pnpm --filter @ripieno/engine typecheck a pnpm test -- guardedExec." }] });
  assert.equal(grounded.complete, false);
  assert.equal(grounded.scenarios.length, 0);
}));

test("scenario budget never silently truncates grounded checks or additional assertions", async () => fixture(async (workspacePath) => {
  await assert.rejects(groundQaCommands({ workspacePath, criteria: [
    { id: "one", description: "first", check: steps[0] },
    { id: "two", description: "second", check: steps[1] },
  ], hasSpec: true, tasks: [], maxScenarios: 1 }), /without discarding assertions/);
  const grounded = { complete: false, promptContext: "", scenarios: [{ id: "required", name: "contract", kind: "cli" as const, criterionId: "c1", steps, expect: "exit code 0" }] };
  const generated = Array.from({ length: 14 }, (_, n) => ({ id: `ui-${n}`, name: "UI", kind: "web" as const, steps: ["screenshot"], expect: "button visible" }));
  assert.throws(() => applyGroundedQaCommands(generated, grounded), /without discarding assertions/);
  assert.equal(applyGroundedQaCommands(generated.slice(0, 13), grounded).length, 14);
}));
