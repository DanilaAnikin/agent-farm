import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_AUTO_WISHES_PER_DAY,
  czCount,
  decideSuggestion,
  joinRationale,
  mapSuggestionProject,
  parseMaxAutoWishes,
} from "./suggestions.js";
import type { SuggestionIntakeInput } from "./suggestions.js";
import { isLikelyEnglishTitle, OPEN_TASK_STATUSES } from "./refill.js";
import { decideStuckAction, STUCK_RESPEC_AFTER_MS } from "./stuck-policy.js";
import { goalFromNote } from "./supervisor.js";

const base: SuggestionIntakeInput = {
  projectId: "p1",
  mention: null,
  projectStatus: "active",
  dedup: { known: false },
  hasOpenWork: false,
  autoWishesToday: 0,
  maxAutoWishesPerDay: 2,
};

test("intake: návrh bez projektu zmiňující víc projektů → cross_project", () => {
  assert.deepEqual(decideSuggestion({ ...base, projectId: null, mention: "many", projectStatus: null, dedup: null }), {
    action: "dismiss",
    reason: "cross_project",
  });
});

test("intake: návrh bez projektu, který žádný projekt nezmiňuje → no_project", () => {
  assert.deepEqual(decideSuggestion({ ...base, projectId: null, mention: "none", projectStatus: null, dedup: null }), {
    action: "dismiss",
    reason: "no_project",
  });
  // project_id ukazuje na projekt, který neexistuje / patří jinému uživateli
  assert.deepEqual(decideSuggestion({ ...base, projectStatus: null, dedup: null }), {
    action: "dismiss",
    reason: "no_project",
  });
});

test("intake: do pozastaveného projektu nikdy — ani když je volno", () => {
  for (const status of ["paused", "budget_hold", "stopped"] as const) {
    assert.deepEqual(decideSuggestion({ ...base, projectStatus: status, dedup: null }), {
      action: "dismiss",
      reason: "project_paused",
    });
  }
});

test("intake: duplicita se zahodí dřív, než rozhodnou limity", () => {
  assert.deepEqual(decideSuggestion({ ...base, dedup: { known: true } }), { action: "dismiss", reason: "duplicate" });
  assert.deepEqual(decideSuggestion({ ...base, dedup: { known: true }, hasOpenWork: true }), {
    action: "dismiss",
    reason: "duplicate",
  });
});

test("intake: nejistá duplicita se neodhaduje — návrh počká", () => {
  assert.deepEqual(decideSuggestion({ ...base, dedup: { known: true, uncertain: true } }), {
    action: "defer",
    reason: "dedup_pending",
  });
  assert.deepEqual(decideSuggestion({ ...base, dedup: { known: false, uncertain: true }, hasOpenWork: true }), {
    action: "defer",
    reason: "open_work",
  });
});

test("intake: denní limit a rozdělaná práce návrh odloží (zůstává new)", () => {
  assert.deepEqual(decideSuggestion({ ...base, autoWishesToday: 2 }), { action: "defer", reason: "daily_limit" });
  assert.deepEqual(decideSuggestion({ ...base, maxAutoWishesPerDay: 0 }), { action: "defer", reason: "daily_limit" });
  assert.deepEqual(decideSuggestion({ ...base, hasOpenWork: true }), { action: "defer", reason: "open_work" });
});

test("intake: jinak farma návrh sama zadá", () => {
  assert.deepEqual(decideSuggestion(base), { action: "convert", reason: "converted" });
  assert.deepEqual(decideSuggestion({ ...base, autoWishesToday: 1 }), { action: "convert", reason: "converted" });
});

test("mapování projektu podle jmen: celé slovo, diakritika a pomlčky nevadí", () => {
  const projects = [
    { id: "a", name: "ripieno" },
    { id: "b", name: "life-admin-agent" },
    { id: "c", name: "loot" },
  ];
  assert.deepEqual(mapSuggestionProject("Napojit Ripieno na Sentry", "", projects), { kind: "one", projectId: "a" });
  assert.deepEqual(mapSuggestionProject("Přehled", "life admin agent posílá upomínky", projects), {
    kind: "one",
    projectId: "b",
  });
  const many = mapSuggestionProject("Sdílet přihlášení", "mezi ripieno a loot", projects);
  assert.equal(many.kind, "many");
  assert.deepEqual(mapSuggestionProject("Lootbox animace", "", projects), { kind: "none" });
  assert.deepEqual(mapSuggestionProject("", "", []), { kind: "none" });
});

test("max_auto_wishes_per_day: nesmyslná hodnota spadne na výchozí 2", () => {
  assert.equal(parseMaxAutoWishes(3), 3);
  assert.equal(parseMaxAutoWishes("1"), 1);
  assert.equal(parseMaxAutoWishes(0), 0);
  assert.equal(parseMaxAutoWishes(2.7), 2);
  assert.equal(parseMaxAutoWishes(-1), DEFAULT_MAX_AUTO_WISHES_PER_DAY);
  assert.equal(parseMaxAutoWishes(null), DEFAULT_MAX_AUTO_WISHES_PER_DAY);
  assert.equal(parseMaxAutoWishes({}), DEFAULT_MAX_AUTO_WISHES_PER_DAY);
  assert.equal(parseMaxAutoWishes(""), DEFAULT_MAX_AUTO_WISHES_PER_DAY);
});

test("rozdělaná práce zahrnuje merging (kód ještě není v main)", () => {
  assert.ok(OPEN_TASK_STATUSES.includes("merging"));
  assert.ok(!OPEN_TASK_STATUSES.includes("done"));
  assert.ok(!OPEN_TASK_STATUSES.includes("parked"));
});

test("jazyk názvu úkolu: anglické sloveso bez diakritiky se nahlásí, český název ne", () => {
  assert.equal(isLikelyEnglishTitle("Add /login route with form"), true);
  assert.equal(isLikelyEnglishTitle("Set up Jest with ts-jest"), true);
  assert.equal(isLikelyEnglishTitle("Přidat /login s formulářem"), false);
  assert.equal(isLikelyEnglishTitle("Nastavit Jest s ts-jest"), false);
  assert.equal(isLikelyEnglishTitle("README: sekce o nasazení"), false);
  assert.equal(isLikelyEnglishTitle(""), false);
});

test("uvázlé přání: po 12 h jedna re-specifikace, další selhání uzavře", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const common = { status: "specifying" as const, projectActive: true, now };
  assert.equal(decideStuckAction({ ...common, stuckAt: hoursAgo(1), respecAt: null }), "wait");
  assert.equal(
    decideStuckAction({ ...common, stuckAt: new Date(now.getTime() - STUCK_RESPEC_AFTER_MS), respecAt: null }),
    "respec",
  );
  // re-specifikace běží (stuck je starší než pokus)
  assert.equal(decideStuckAction({ ...common, stuckAt: hoursAgo(20), respecAt: hoursAgo(2) }), "wait");
  // uvázlo znovu po re-specifikaci → uzavřít, žádná druhá re-specifikace
  assert.equal(decideStuckAction({ ...common, stuckAt: hoursAgo(1), respecAt: hoursAgo(2) }), "archive");
  assert.equal(decideStuckAction({ ...common, stuckAt: hoursAgo(1), respecAt: hoursAgo(30) }), "archive");
  // pozastavený projekt: nic nepálit
  assert.equal(decideStuckAction({ ...common, projectActive: false, stuckAt: hoursAgo(40), respecAt: null }), "wait");
  // přání už je 'new' a čeká na managera
  assert.equal(decideStuckAction({ ...common, status: "new", stuckAt: hoursAgo(40), respecAt: null }), "wait");
  // re-specifikace starší než týden se nepočítá → nový cyklus
  assert.equal(decideStuckAction({ ...common, stuckAt: hoursAgo(13), respecAt: hoursAgo(24 * 8) }), "respec");
});

test("supervisor: prázdná poznámka majitele neprojde jako cíl projektu", () => {
  assert.equal(goalFromNote("", "ripieno"), "ripieno");
  assert.equal(goalFromNote("   ", "ripieno"), "ripieno");
  assert.equal(goalFromNote(null, "ripieno"), "ripieno");
  assert.equal(goalFromNote(" Zaměř se na onboarding ", "ripieno"), "Zaměř se na onboarding");
});

test("zdůvodnění návrhu nese doklad z repozitáře; české plurály", () => {
  assert.equal(joinRationale("Sníží chybovost", "apps/web/login.tsx"), "Sníží chybovost\nDoklad z repozitáře: apps/web/login.tsx");
  assert.equal(joinRationale(null, "  "), null);
  assert.equal(joinRationale("", "package.json"), "Doklad z repozitáře: package.json");
  const forms = ["návrh", "návrhy", "návrhů"] as const;
  assert.equal(czCount(0, forms), "0 návrhů");
  assert.equal(czCount(1, forms), "1 návrh");
  assert.equal(czCount(3, forms), "3 návrhy");
  assert.equal(czCount(5, forms), "5 návrhů");
});
