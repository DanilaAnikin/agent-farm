import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { judgeContainerCommand } from "./docker.js";

test("judge executes the complete check script and returns its real exit status", () => {
  const command = judgeContainerCommand("printf '%s\\n' 'BUILD_EXIT=0' 'TEST_EXIT=7' 'LINT_EXIT=0'; exit 7");
  const [entrypoint, ...args] = command.Entrypoint;
  assert.ok(entrypoint);
  const result = spawnSync(entrypoint, [...args, ...command.Cmd], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "BUILD_EXIT=0\nTEST_EXIT=7\nLINT_EXIT=0\n");
});

test("judge preserves shell quoting and keeps stdout and stderr separate", () => {
  const command = judgeContainerCommand("printf '%s\\n' 'literal $HOME; a b'; printf '%s\\n' 'test failed' >&2");
  const [entrypoint, ...args] = command.Entrypoint;
  assert.ok(entrypoint);
  const result = spawnSync(entrypoint, [...args, ...command.Cmd], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "literal $HOME; a b\n");
  assert.equal(result.stderr, "test failed\n");
});
