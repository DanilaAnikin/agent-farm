import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAgentHint, projectIdleSentence, projectStatusLine, projectWaitingPredicate } from "./project-status";

test("budget_hold se nevydává za ručně pozastavený projekt", () => {
  assert.equal(projectStatusLine("budget_hold"), "Projekt čeká na rozpočet");
  assert.doesNotMatch(projectIdleSentence("budget_hold") ?? "", /pozastaven/);
  assert.match(projectIdleSentence("budget_hold") ?? "", /sám po resetu okna/);
  assert.doesNotMatch(projectWaitingPredicate("budget_hold"), /pozastaven/);
  assert.doesNotMatch(projectAgentHint("budget_hold") ?? "", /pozastaven/);
});

test("postupný náběh bez anglicismu „rollout“", () => {
  for (const text of [
    projectStatusLine("stopped"),
    projectIdleSentence("stopped") ?? "",
    projectWaitingPredicate("stopped"),
    projectAgentHint("stopped") ?? "",
  ]) {
    assert.doesNotMatch(text, /rollout/i);
    assert.match(text, /postupné zapnutí/);
  }
});

test("ruční pauza a běžící projekt", () => {
  assert.equal(projectIdleSentence("paused"), "Projekt je pozastavený.");
  assert.equal(projectWaitingPredicate("paused"), "je pozastavený");
  assert.equal(projectIdleSentence("active"), null);
  assert.equal(projectAgentHint("active"), null);
  assert.equal(projectStatusLine("active"), "Projekt aktivní");
});
