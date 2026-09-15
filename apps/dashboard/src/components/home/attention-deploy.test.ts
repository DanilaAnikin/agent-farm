import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { attentionSummary, sortAttention, type AttentionLike } from "./attention-summary";
import { NOISE_EVENT_TYPES } from "../../lib/event-labels";

test("selhané nasazení je incident s českým souhrnem a jde před uvízlé úkoly", () => {
  const items: AttentionLike[] = [
    { kind: "task_stuck", severity: "warn", since: "2026-09-15T08:00:00Z" },
    { kind: "deploy_failed", severity: "error", since: "2026-09-15T16:23:54Z" },
    { kind: "deploy_failed", severity: "error", since: "2026-09-14T22:20:44Z" },
  ];
  assert.equal(sortAttention(items)[0]!.kind, "deploy_failed");
  assert.equal(attentionSummary(items), "2 selhaná nasazení · 1 uvízlý úkol");
});

test("migrace 0017: farm_attention hlásí deploy_failed a odmítnutí kvůli zastavené farmě vynechá", () => {
  const sql = readFileSync(new URL("../../../../../packages/db/migrations/0017_budget_wait_attention.sql", import.meta.url), "utf8");
  assert.match(sql, /'kind', 'deploy_failed'/);
  assert.match(sql, /ILIKE '%zamítnut%'/);
  // Stav farmy potřebuje souhrny, se kterými počítá farmState().
  for (const klic of ["budget_hold_projects", "budget_hold_queued", "budget_hold_since", "budget_hold_reasons", "active_work"]) {
    assert.match(sql, new RegExp(`'${klic}'`));
  }
  // SECURITY DEFINER obchází RLS → souhrny musí filtrovat projekty jako `projects_self`.
  const runState = sql.slice(sql.indexOf("FUNCTION public.farm_run_state()"), sql.indexOf("FUNCTION public.farm_attention()"));
  assert.match(runState, /public\.is_admin\(\)/);
  assert.match(runState, /p\.user_id = ja\.uid/);
  assert.doesNotMatch(runState, /FROM public\.projects p\s+WHERE p\.status/);
  // Detail selhaného nasazení má mezi větami oddělovač.
  assert.match(sql, /' · Selhání za 7 dní: '/);
  // Poslední událost projektu bere šum z dashboardu jako parametr.
  assert.match(sql, /project_last_event\(p_exclude text\[\]\)/);
  assert.ok(NOISE_EVENT_TYPES.includes("best_of_n_started"));
});
