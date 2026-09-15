import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionSummary, sortAttention, type AttentionLike } from "./attention-summary";

const items: AttentionLike[] = [
  { kind: "agent_stalled", severity: "warn", since: "2026-09-15T10:00:00Z" },
  { kind: "task_stuck", severity: "warn", since: "2026-09-15T08:00:00Z" },
  { kind: "task_stuck", severity: "warn", since: "2026-09-15T06:00:00Z" },
  { kind: "guard_not_ready", severity: "error", since: "2026-09-14T22:19:00Z" },
];

test("chyby a blokace celé farmy jdou první, pak nejdéle trvající", () => {
  const s = sortAttention(items);
  assert.equal(s[0]!.kind, "guard_not_ready");
  assert.equal(s[1]!.kind, "task_stuck");
  assert.equal(s[1]!.since, "2026-09-15T06:00:00Z");
  assert.equal(s[3]!.kind, "agent_stalled");
});

test("souhrn podle kategorií s českými tvary", () => {
  assert.equal(
    attentionSummary(items),
    "1 zamčený hlídač · 2 uvízlé úkoly · 1 agent bez signálu",
  );
  assert.equal(attentionSummary([]), "");
});
