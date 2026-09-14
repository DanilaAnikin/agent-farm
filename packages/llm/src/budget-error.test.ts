import assert from "node:assert/strict";
import { test } from "node:test";
import { isLlmBudgetError, LlmError } from "./client.js";

test("recognizes structured and nested provider budget refusals", () => {
  assert.equal(isLlmBudgetError(new LlmError("request refused", 402)), true);
  assert.equal(isLlmBudgetError(new Error("opencode: 402 budget exceeded")), true);
  assert.equal(isLlmBudgetError(new LlmError("LLM request failed: 400", 400,
    '{"error":"Budget has been exceeded"}')), true);
});

test("does not treat malformed tasks, validation or network failures as budget waits", () => {
  for (const error of [new Error("Structured output validation failed after retry."),
    new LlmError("bad input", 400), new LlmError("timeout", 503),
    new Error("missing budget column"), null]) {
    assert.equal(isLlmBudgetError(error), false);
  }
});
