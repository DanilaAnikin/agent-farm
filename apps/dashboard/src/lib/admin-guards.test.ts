import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  EDITOVATELNE_KLICE,
  MODEL_ALIAS_TO_MODEL,
  SYSTEM_PROJECT_LABEL,
  agentHealthSummary,
  aggregateCosts,
  canChangeRole,
  clampCap,
  effectiveUserCaps,
  inviteExpiresAt,
  inviteRejection,
  inviteState,
  isAgentListed,
  isEditableConnectionKind,
  isEditableFarmSetting,
  layerRatio,
  mergeCapsOverride,
  mergePreferenceProfile,
  modelLabel,
  nearestCapKey,
  normalizeUserCap,
  parseDecimalInput,
  planOwnerToggle,
  poskytovatelLabel,
  sanitizeConnectionMeta,
  validateEmail,
  validateFarmSetting,
  validatePat,
  validateProfileInput,
  type CapLayer,
} from "./admin-guards";
import { resolveResumeAction } from "./farm-state";

// --- čísla -------------------------------------------------------------------

test("parseDecimalInput: čárka i tečka, prázdno = null, nesmysl = NaN", () => {
  assert.equal(parseDecimalInput("0,60"), 0.6);
  assert.equal(parseDecimalInput("0.6"), 0.6);
  assert.equal(parseDecimalInput(" 20 "), 20);
  assert.equal(parseDecimalInput("1,5 US$"), 1.5);
  assert.equal(parseDecimalInput(""), null);
  assert.ok(Number.isNaN(parseDecimalInput("1,2,3")));
  assert.ok(Number.isNaN(parseDecimalInput("abc")));
  assert.ok(Number.isNaN(parseDecimalInput({})));
});

test("clampCap: NaN a nečísla → null, jinak oříznutí do rozsahu", () => {
  assert.equal(clampCap(Number.NaN, 20), null);
  assert.equal(clampCap(Number.POSITIVE_INFINITY, 20), null);
  assert.equal(clampCap("5", 20), null);
  assert.equal(clampCap(null, 20), null);
  assert.equal(clampCap(-1, 20), 0);
  assert.equal(clampCap(25, 20), 20);
  assert.equal(clampCap(0.6, 20), 0.6);
});

// --- farm_settings -----------------------------------------------------------

test("whitelist klíčů: stropy ano, pauza/hlídače ne", () => {
  for (const k of Object.keys(EDITOVATELNE_KLICE)) assert.equal(isEditableFarmSetting(k), true);
  for (const k of [
    "owner_pause",
    "global_pause",
    "pause_source",
    "budget_block",
    "month_guard_spent_usd",
    "deepseek_balance_usd",
    "toString",
    "__proto__",
    "",
    42,
  ]) {
    assert.equal(isEditableFarmSetting(k), false, String(k));
  }
});

test("validateFarmSetting: NaN, mimo rozsah a zakázaný klíč se odmítnou", () => {
  assert.equal(validateFarmSetting("farm_daily_cap_usd", 0.6).ok, true);
  assert.equal(validateFarmSetting("farm_daily_cap_usd", 0).ok, true);
  assert.equal(validateFarmSetting("farm_daily_cap_usd", Number.NaN).ok, false);
  assert.equal(validateFarmSetting("farm_daily_cap_usd", "0.6").ok, false);
  assert.equal(validateFarmSetting("farm_daily_cap_usd", 5.01).ok, false);
  assert.equal(validateFarmSetting("farm_daily_cap_usd", -0.01).ok, false);
  assert.equal(validateFarmSetting("farm_monthly_cap_usd", 50).ok, true);
  assert.equal(validateFarmSetting("farm_monthly_cap_usd", 51).ok, false);
  assert.equal(validateFarmSetting("max_workers_total", 0).ok, false);
  assert.equal(validateFarmSetting("max_workers_total", 1.5).ok, false);
  assert.equal(validateFarmSetting("max_workers_total", 2).ok, true);
  const zakazany = validateFarmSetting("owner_pause", 0);
  assert.equal(zakazany.ok, false);
});

// --- role a stropy uživatelů ---------------------------------------------------

test("canChangeRole: poslední admin, degradace sebe sama, neznámá role", () => {
  const zaklad = { actorId: "a", targetId: "b", currentRole: "admin", nextRole: "member", adminCount: 2 };
  assert.deepEqual(canChangeRole(zaklad), { ok: true });

  const posledni = canChangeRole({ ...zaklad, adminCount: 1 });
  assert.equal(posledni.ok, false);
  assert.match((posledni as { message: string }).message, /poslednímu administrátorovi/);

  const sebe = canChangeRole({ ...zaklad, targetId: "a" });
  assert.equal(sebe.ok, false);
  assert.match((sebe as { message: string }).message, /Sám sobě/);

  assert.equal(canChangeRole({ ...zaklad, nextRole: "owner" }).ok, false);
  assert.equal(canChangeRole({ ...zaklad, currentRole: "member", nextRole: "admin", adminCount: 1 }).ok, true);
  // Ponechání role je vždy v pořádku, i u posledního admina.
  assert.equal(canChangeRole({ ...zaklad, targetId: "a", nextRole: "admin", adminCount: 1 }).ok, true);
});

test("normalizeUserCap: prázdné a NaN odmítne, nikdy nad strop farmy ani 20 US$", () => {
  assert.equal(normalizeUserCap("", 0.6).ok, false);
  assert.equal(normalizeUserCap(null, 0.6).ok, false);
  assert.equal(normalizeUserCap(Number.NaN, 0.6).ok, false);
  assert.equal(normalizeUserCap("abc", 0.6).ok, false);
  assert.deepEqual(normalizeUserCap(15, 0.6), { ok: true, value: 0.6, clamped: true });
  assert.deepEqual(normalizeUserCap("0,4", 0.6), { ok: true, value: 0.4, clamped: false });
  assert.deepEqual(normalizeUserCap(25, 100), { ok: true, value: 20, clamped: true });
  assert.deepEqual(normalizeUserCap(-3, 0.6), { ok: true, value: 0, clamped: true });
});

test("mergeCapsOverride: zachová ostatní klíče, nečísla zahodí", () => {
  const puvodni = { maxWorkers: 2, dailyCapUsd: 0.6, maxProjects: 50, dailyMediaCapUsd: 0.2 };
  assert.deepEqual(mergeCapsOverride(puvodni, { dailyCapUsd: 0.5 }), { ...puvodni, dailyCapUsd: 0.5 });
  assert.deepEqual(mergeCapsOverride(null, { dailyCapUsd: 0.5, dailyMediaCapUsd: Number.NaN }), {
    dailyCapUsd: 0.5,
  });
  assert.deepEqual(mergeCapsOverride({ x: "nesmysl", maxWorkers: 1 }, {}), { maxWorkers: 1 });
});

test("effectiveUserCaps: plán + ruční přepis, surové sloupce profilu se nečtou", () => {
  const caps = effectiveUserCaps({
    plan_key: "free",
    subscription_status: "none",
    caps_override: { dailyCapUsd: 0.6, dailyMediaCapUsd: 0.2 },
  });
  assert.equal(caps.dailyCapUsd, 0.6);
  assert.equal(caps.dailyMediaCapUsd, 0.2);
  assert.equal(caps.hasOverride, true);
  assert.equal(caps.sourceLabel, "plán Free + ruční přepis");

  const bez = effectiveUserCaps({ plan_key: "free", caps_override: null });
  assert.equal(bez.hasOverride, false);
  assert.equal(bez.sourceLabel, "plán Free");
});

// --- vypínač -------------------------------------------------------------------

test("resolveResumeAction + planOwnerToggle: automatickou pauzu ruční klik nepřebije", () => {
  for (const zdroj of ["offpeak", "credit", "month"]) {
    const w = planOwnerToggle(false, resolveResumeAction(zdroj));
    assert.equal(w.ownerPause, false);
    assert.equal(w.clearGlobalPause, false, zdroj);
    assert.equal(w.clearPauseSource, false, zdroj);
    assert.match(w.message, /spustí se sama/);
  }
  for (const zdroj of [null, "owner", undefined]) {
    const w = planOwnerToggle(false, resolveResumeAction(zdroj));
    assert.equal(w.clearGlobalPause, true);
    assert.equal(w.clearPauseSource, true);
  }
  const stop = planOwnerToggle(true, resolveResumeAction("offpeak"));
  assert.deepEqual(
    { ownerPause: stop.ownerPause, clearGlobalPause: stop.clearGlobalPause, clearPauseSource: stop.clearPauseSource },
    { ownerPause: true, clearGlobalPause: false, clearPauseSource: false },
  );
});

// --- připojení -----------------------------------------------------------------

test("validatePat: formát, délka a typ", () => {
  const fg = "github_pat_" + "A1b2C3d4E5".repeat(8);
  assert.deepEqual(validatePat(`  ${fg}  `), { ok: true, value: fg });
  assert.equal(validatePat("ghp_" + "a".repeat(36)).ok, true);
  assert.equal(validatePat("ghp_kratky").ok, false);
  assert.equal(validatePat("x".repeat(40)).ok, false);
  assert.equal(validatePat("github_pat_" + "a".repeat(600)).ok, false);
  assert.equal(validatePat(`github_pat_${"a".repeat(30)} mezera`).ok, false);
  assert.equal(validatePat({ token: fg }).ok, false);
  assert.equal(validatePat(undefined).ok, false);
});

test("connections: jen github a jen povolené klíče v meta", () => {
  assert.equal(isEditableConnectionKind("github"), true);
  assert.equal(isEditableConnectionKind("instagram"), false);
  assert.equal(isEditableConnectionKind(null), false);
  assert.deepEqual(sanitizeConnectionMeta({ label: " můj ", evil: "x", account: 5 }), { label: "můj" });
  assert.deepEqual(sanitizeConnectionMeta([1, 2]), {});
});

// --- pozvánky ------------------------------------------------------------------

test("validateEmail: normalizace a odmítnutí nesmyslu", () => {
  assert.deepEqual(validateEmail(" Jan@Firma.CZ "), { ok: true, value: "jan@firma.cz" });
  assert.equal(validateEmail("").ok, false);
  assert.equal(validateEmail("bez-zavinace").ok, false);
  assert.equal(validateEmail("a@b").ok, false);
  assert.equal(validateEmail("a b@c.cz").ok, false);
  assert.equal(validateEmail(null).ok, false);
});

test("pozvánky: expirace, zrušení, použití", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  assert.equal(inviteExpiresAt(now), "2026-09-22T12:00:00.000Z");
  assert.equal(inviteState({ used_at: null, revoked_at: null, expires_at: null }, now), "active");
  assert.equal(inviteState({ used_at: null, expires_at: "2026-09-16T00:00:00Z" }, now), "active");
  assert.equal(inviteState({ used_at: null, expires_at: "2026-09-15T11:59:59Z" }, now), "expired");
  assert.equal(inviteState({ used_at: null, revoked_at: "2026-09-14T00:00:00Z" }, now), "revoked");
  assert.equal(inviteState({ used_at: "2026-09-14T00:00:00Z", revoked_at: "x" }, now), "used");
  assert.equal(inviteRejection({ used_at: null }, now), null);
  assert.match(inviteRejection({ used_at: null, expires_at: "2026-09-01T00:00:00Z" }, now) ?? "", /vypršela/);
  assert.match(inviteRejection({ used_at: null, revoked_at: "2026-09-01T00:00:00Z" }, now) ?? "", /zrušena/);
});

// --- profil --------------------------------------------------------------------

test("validateProfileInput: limity délky, počet položek, logo jen http(s)", () => {
  const ok = validateProfileInput({ display_name: " Dan ", brand_colors: "#000\n\n#fff\n", brand_logo: "https://x.cz/l.png" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.displayName, "Dan");
    assert.deepEqual(ok.value.profile.brand.colors, ["#000", "#fff"]);
  }
  assert.equal(validateProfileInput({ display_name: "x".repeat(81) }).ok, false);
  assert.equal(validateProfileInput({ tone: "x".repeat(2001) }).ok, false);
  assert.equal(validateProfileInput({ dos: Array.from({ length: 51 }, (_, i) => `p${i}`).join("\n") }).ok, false);
  assert.equal(validateProfileInput({ brand_logo: "javascript:alert(1)" }).ok, false);
  assert.equal(validateProfileInput({ brand_logo: "ftp://x.cz/a" }).ok, false);
  assert.equal(validateProfileInput({ brand_logo: 42 }).ok, true);
});

test("mergePreferenceProfile: neznámé klíče zůstanou, formulářová pole se přepíšou", () => {
  const out = mergePreferenceProfile(
    { tone: "starý", extra: { a: 1 }, brand: { colors: ["#111"], motto: "zůstaň" } },
    { tone: undefined, brand: { colors: ["#222"], fonts: [] }, dos: ["a"], donts: [] },
  );
  assert.deepEqual(out, {
    extra: { a: 1 },
    brand: { colors: ["#222"], motto: "zůstaň", fonts: [] },
    dos: ["a"],
    donts: [],
  });
});

// --- agenti --------------------------------------------------------------------

test("agentHealthSummary: tepající idle manager je živý, netepající busy je bez tepu", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const pred = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  const souhrn = agentHealthSummary(
    [
      { status: "idle", last_heartbeat: pred(5) },
      { status: "busy", last_heartbeat: pred(30) },
      { status: "busy", last_heartbeat: pred(600) },
      { status: "dead", last_heartbeat: pred(99999) },
    ],
    now,
  );
  assert.deepEqual(souhrn, { live: 2, working: 1, silent: 1 });
  assert.equal(isAgentListed({ status: "dead", last_heartbeat: pred(3600) }, now), true);
  assert.equal(isAgentListed({ status: "dead", last_heartbeat: pred(2 * 86400) }, now), false);
  assert.equal(isAgentListed({ status: "idle", last_heartbeat: pred(2 * 86400) }, now), true);
});

// --- modely --------------------------------------------------------------------

test("modelLabel: aliasy na skutečný model a zkrácený popisek", () => {
  assert.equal(modelLabel("worker"), "DeepSeek V4 Pro");
  assert.equal(modelLabel("deepseek/deepseek-v4-flash"), "DeepSeek V4 Flash");
  assert.equal(modelLabel(null), "—");
  assert.equal(poskytovatelLabel(""), "—");
  assert.equal(poskytovatelLabel("deepseek"), "DeepSeek");
});

test("MODEL_ALIAS_TO_MODEL odpovídá infra/litellm/config.yaml", () => {
  const yaml = readFileSync(new URL("../../../../infra/litellm/config.yaml", import.meta.url), "utf8");
  const zConfigu: Record<string, string> = {};
  let alias: string | null = null;
  for (const radek of yaml.split("\n")) {
    const jmeno = radek.match(/^\s*-\s*model_name:\s*(\S+)/);
    if (jmeno) {
      alias = jmeno[1]!;
      continue;
    }
    const model = radek.match(/^\s+model:\s*(\S+)/);
    if (model && alias && !(alias in zConfigu)) zConfigu[alias] = model[1]!;
  }
  assert.ok(Object.keys(zConfigu).length > 0, "v configu nejsou žádné model_name");
  assert.deepEqual(MODEL_ALIAS_TO_MODEL, zConfigu);
});

// --- náklady -------------------------------------------------------------------

test("aggregateCosts: jen nenulové řádky, Systém v grafu projektů, součty sedí", () => {
  const dny = ["2026-09-14", "2026-09-15"];
  const agg = aggregateCosts(
    [
      { day: "2026-09-14", project_id: "p1", scope: "attempt", model: "deepseek/deepseek-v4-pro", provider: "deepseek", cost_usd: 1 },
      { day: "2026-09-15", project_id: null, scope: "system", model: "deepseek/deepseek-v4-flash", provider: "deepseek", cost_usd: 0.25 },
      { day: "2026-09-15", project_id: null, scope: "system", model: "cheap", provider: "", cost_usd: 0 },
      { day: "2026-09-01", project_id: "p1", scope: "attempt", model: "worker", provider: "deepseek", cost_usd: 9 },
    ],
    dny,
    (id) => (id === "p1" ? "Ripieno" : "?"),
  );
  assert.equal(agg.total, 1.25);
  assert.deepEqual(agg.byDay, [
    { day: "2026-09-14", real: 1 },
    { day: "2026-09-15", real: 0.25 },
  ]);
  assert.deepEqual(agg.byProject, [
    { name: "Ripieno", value: 1 },
    { name: SYSTEM_PROJECT_LABEL, value: 0.25 },
  ]);
  assert.equal(agg.byProject.reduce((s, p) => s + p.value, 0), agg.total);
  assert.deepEqual(agg.byModel.map((m) => m.name), ["DeepSeek V4 Pro", "DeepSeek V4 Flash"]);
  assert.deepEqual(agg.byPoskytovatel, [{ name: "DeepSeek", value: 1.25 }]);
});

test("mapa stropů: poměr a nejbližší strop", () => {
  const vrstvy: CapLayer[] = [
    { key: "farm_month", label: "", spent: 5.49, cap: 20, guard: "", editWhere: "" },
    { key: "farm_day", label: "", spent: 0.3, cap: 0.6, guard: "", editWhere: "" },
    { key: "media_day", label: "", spent: 0, cap: 0.2, guard: "", editWhere: "" },
    { key: "attempt", label: "", spent: null, cap: null, guard: "", editWhere: "" },
  ];
  assert.equal(layerRatio(vrstvy[1]!), 0.5);
  assert.equal(layerRatio(vrstvy[3]!), null);
  assert.equal(layerRatio({ spent: 0, cap: 0 }), 1);
  assert.equal(nearestCapKey(vrstvy), "farm_day");
  assert.equal(nearestCapKey([]), null);
});
