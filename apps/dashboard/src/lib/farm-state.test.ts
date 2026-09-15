import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capFromSetting,
  farmState,
  isBudgetBlocked,
  isFarmPaused,
  parsePauseSource,
  pauseLabel,
  resolveResumeAction,
} from "./farm-state";
import {
  DEFAULT_OFFPEAK_WINDOWS_UTC,
  hhmmToMinutes,
  isOffpeakUtc,
  lastUtcDays,
  minutesToHhmm,
  nextOffpeakStart,
  parseOffpeakWindows,
  peakWindowsUtc,
  startOfUtcDayIso,
  startOfUtcMonthIso,
} from "./time";

// Výchozí okno: levné hodiny 16:30–00:30 UTC, špička 00:30–16:30 UTC.
const SPICKA = new Date("2026-09-15T10:00:00Z");
const LEVNE = new Date("2026-09-15T18:00:00Z");

// --- pauza -------------------------------------------------------------------

test("isFarmPaused: pauza je OR obou klíčů, ne jen global_pause", () => {
  assert.equal(isFarmPaused({ global_pause: false, owner_pause: false }), false);
  assert.equal(isFarmPaused({ global_pause: true, owner_pause: false }), true);
  // Tohle byl ten tichý bug: /admin i hlavička četly global_pause, ale vypínač
  // zapisoval owner_pause → po kliknutí na „Zastavit vše" svítilo „Běží".
  assert.equal(isFarmPaused({ global_pause: false, owner_pause: true }), true);
  assert.equal(isFarmPaused({}), false);
});

test("isFarmPaused: řetězec \"true\" platí stejně jako boolean", () => {
  // Boolean(value), ne === true — shodně s packages/db/src/pause.ts.
  assert.equal(isFarmPaused({ global_pause: "true" }), true);
  assert.equal(isFarmPaused({ owner_pause: 1 }), true);
});

test("parsePauseSource: jen známé zdroje, zbytek null", () => {
  assert.equal(parsePauseSource("offpeak"), "offpeak");
  assert.equal(parsePauseSource("owner"), "owner");
  assert.equal(parsePauseSource("credit"), "credit");
  assert.equal(parsePauseSource("month"), "month");
  assert.equal(parsePauseSource(null), null);
  assert.equal(parsePauseSource("neco_jineho"), null);
});

test("pauseLabel: každý zdroj má český popis", () => {
  assert.match(pauseLabel("owner"), /majitel/i);
  assert.match(pauseLabel("offpeak"), /hodin/i);
  assert.match(pauseLabel("credit"), /kredit/i);
  assert.match(pauseLabel("month"), /měsíční/i);
  assert.match(pauseLabel(null), /nezn/i);
});

// --- ruční spuštění ----------------------------------------------------------

test("resolveResumeAction: ruční spuštění NESMÍ přebít automatickou pauzu", () => {
  for (const zdroj of ["offpeak", "credit", "month"] as const) {
    const akce = resolveResumeAction(zdroj);
    assert.equal(akce.clearGlobalPause, false, `${zdroj} nesmí shodit global_pause`);
    assert.match(akce.message, /spustí se sama/);
  }
});

test("resolveResumeAction: vlastní pauzu majitele smí shodit celou", () => {
  assert.equal(resolveResumeAction(null).clearGlobalPause, true);
  assert.equal(resolveResumeAction("owner").clearGlobalPause, true);
});

// --- stropy ------------------------------------------------------------------

test("capFromSetting: nikdy NaN, nula je platný strop", () => {
  assert.equal(capFromSetting(0.6, 1), 0.6);
  assert.equal(capFromSetting("0.6", 1), 0.6);
  assert.equal(capFromSetting(0, 1), 0);
  assert.equal(capFromSetting(undefined, 0.6), 0.6);
  assert.equal(capFromSetting(null, 0.6), 0.6);
  assert.equal(capFromSetting("", 0.6), 0.6);
  assert.equal(capFromSetting("nesmysl", 0.6), 0.6);
  assert.equal(capFromSetting(-5, 0.6), 0.6);
  assert.ok(!Number.isNaN(capFromSetting({}, 0.6)));
});

test("isBudgetBlocked: false neblokuje, důvod blokuje", () => {
  assert.equal(isBudgetBlocked(false), false);
  assert.equal(isBudgetBlocked("false"), false);
  assert.equal(isBudgetBlocked(null), false);
  assert.equal(isBudgetBlocked(undefined), false);
  assert.equal(isBudgetBlocked("guard_not_ready"), true);
  assert.equal(isBudgetBlocked("den"), true);
});

// --- stavový automat ---------------------------------------------------------

test("farmState: nic nedrží → běží", () => {
  const s = farmState(
    { owner_pause: false, global_pause: false, budget_block: false, guard_ready: true },
    SPICKA,
  );
  assert.equal(s.code, "running");
  assert.equal(s.paused, false);
  assert.equal(s.tone, "ok");
});

test("farmState: vypínač majitele je nadřazený všemu ostatnímu", () => {
  const s = farmState(
    {
      owner_pause: true,
      global_pause: true,
      pause_source: "offpeak",
      budget_block: "den",
      guard_ready: false,
    },
    LEVNE,
  );
  assert.equal(s.code, "owner");
  assert.equal(s.paused, true);
  assert.match(s.title, /majitel/i);
});

test("farmState: nepřipravený hlídač předběhne i běžící farmu", () => {
  const s = farmState({ owner_pause: false, global_pause: false, guard_ready: false }, SPICKA);
  assert.equal(s.code, "budget");
  assert.equal(s.paused, true);
  assert.equal(s.tone, "danger");
});

test("farmState: guard_ready === null neznamená 'v pořádku'", () => {
  // null = hlídač nedostupný; sám o sobě pauzu netvoří, ale ani nelže o nule.
  const s = farmState(
    { owner_pause: false, global_pause: false, guard_ready: null, budget_block: false },
    SPICKA,
  );
  assert.equal(s.code, "running");
});

test("farmState: ve špičce stojí SPRÁVNĚ a řekne, kdy se pustí", () => {
  const s = farmState(
    { global_pause: true, pause_source: "offpeak", budget_block: false },
    SPICKA,
  );
  assert.equal(s.code, "offpeak_expected");
  assert.equal(s.paused, true);
  assert.equal(s.tone, "info");
  assert.ok(s.nextResumeAt);
  assert.equal(new Date(s.nextResumeAt!).toISOString(), "2026-09-15T16:30:00.000Z");
  // Čas se člověku ukazuje v Praze (18:30), i když se okno počítá v UTC.
  assert.match(s.detail, /18:30/);
  assert.match(s.detail, /Europe\/Prague/);
});

test("farmState: v levném okně je pauza 'offpeak' PORUCHA, ne plán", () => {
  const s = farmState(
    { global_pause: true, pause_source: "offpeak", budget_block: false },
    LEVNE,
  );
  assert.equal(s.code, "offpeak_overdue");
  assert.equal(s.tone, "danger");
  assert.match(s.title, /nerozjela/);
});

test("farmState: kredit a měsíc se pustí samy, ale nejsou 'running'", () => {
  const kredit = farmState({ global_pause: true, pause_source: "credit" }, LEVNE);
  assert.equal(kredit.code, "budget");
  assert.match(kredit.title, /kredit/i);
  const mesic = farmState({ global_pause: true, pause_source: "month" }, LEVNE);
  assert.equal(mesic.code, "budget");
  assert.match(mesic.title, /měsíční/i);
});

test("farmState: pauza bez zdroje je porucha — nikdo ji sám nezruší", () => {
  const s = farmState({ global_pause: true, pause_source: null }, LEVNE);
  assert.equal(s.code, "unknown_pause");
  assert.equal(s.tone, "danger");
});

test("farmState: historický zápis pause_source='owner' v global_pause", () => {
  const s = farmState({ global_pause: true, owner_pause: false, pause_source: "owner" }, LEVNE);
  assert.equal(s.code, "owner");
});

test("farmState: vlastní okna z nastavení přebijí výchozí", () => {
  const okna = [{ start: "08:00", end: "09:00" }];
  const uvnitr = farmState(
    { global_pause: true, pause_source: "offpeak", offpeak_windows_utc: okna },
    new Date("2026-09-15T08:30:00Z"),
  );
  assert.equal(uvnitr.code, "offpeak_overdue");
  const venku = farmState(
    { global_pause: true, pause_source: "offpeak", offpeak_windows_utc: okna },
    new Date("2026-09-15T10:00:00Z"),
  );
  assert.equal(venku.code, "offpeak_expected");
  assert.equal(new Date(venku.nextResumeAt!).toISOString(), "2026-09-16T08:00:00.000Z");
});

test("farmState: next_resume_at z DB má přednost před dopočtem", () => {
  const s = farmState(
    {
      global_pause: true,
      pause_source: "offpeak",
      next_resume_at: "2026-09-15T17:00:00.000Z",
    },
    SPICKA,
  );
  assert.equal(s.nextResumeAt, "2026-09-15T17:00:00.000Z");
});

// --- okna a UTC výpočty ------------------------------------------------------

test("hhmmToMinutes / minutesToHhmm", () => {
  assert.equal(hhmmToMinutes("16:30"), 990);
  assert.equal(hhmmToMinutes("00:30"), 30);
  assert.equal(hhmmToMinutes("7:05"), 425);
  assert.equal(hhmmToMinutes("24:00"), null);
  assert.equal(hhmmToMinutes("nesmysl"), null);
  assert.equal(hhmmToMinutes(null), null);
  assert.equal(minutesToHhmm(990), "16:30");
  assert.equal(minutesToHhmm(1440), "24:00");
  assert.equal(minutesToHhmm(0), "00:00");
});

test("parseOffpeakWindows: vadné nastavení spadne na výchozí okno", () => {
  assert.deepEqual(parseOffpeakWindows(null), DEFAULT_OFFPEAK_WINDOWS_UTC);
  assert.deepEqual(parseOffpeakWindows("nesmysl"), DEFAULT_OFFPEAK_WINDOWS_UTC);
  assert.deepEqual(parseOffpeakWindows([]), DEFAULT_OFFPEAK_WINDOWS_UTC);
  assert.deepEqual(parseOffpeakWindows([{ start: "x", end: "y" }]), DEFAULT_OFFPEAK_WINDOWS_UTC);
  assert.deepEqual(parseOffpeakWindows([{ start: "01:00", end: "02:00" }]), [
    { start: "01:00", end: "02:00" },
  ]);
});

test("isOffpeakUtc: okno přes půlnoc platí na obou stranách", () => {
  assert.equal(isOffpeakUtc(new Date("2026-09-15T16:29:00Z")), false);
  assert.equal(isOffpeakUtc(new Date("2026-09-15T16:30:00Z")), true);
  assert.equal(isOffpeakUtc(new Date("2026-09-15T23:59:00Z")), true);
  assert.equal(isOffpeakUtc(new Date("2026-09-15T00:29:00Z")), true);
  assert.equal(isOffpeakUtc(new Date("2026-09-15T00:30:00Z")), false);
});

test("peakWindowsUtc: doplněk levných oken", () => {
  assert.deepEqual(peakWindowsUtc(), [{ start: "00:30", end: "16:30" }]);
  assert.deepEqual(peakWindowsUtc([{ start: "01:00", end: "02:00" }]), [
    { start: "00:00", end: "01:00" },
    { start: "02:00", end: "24:00" },
  ]);
});

test("nextOffpeakStart: v levném okně je odpověď 'hned'", () => {
  assert.equal(nextOffpeakStart(LEVNE)?.toISOString(), LEVNE.toISOString());
});

test("nextOffpeakStart: ve špičce vrátí nejbližší začátek okna", () => {
  assert.equal(nextOffpeakStart(SPICKA)?.toISOString(), "2026-09-15T16:30:00.000Z");
  // Krátce po skončení okna se čeká na zítřek.
  assert.equal(
    nextOffpeakStart(new Date("2026-09-15T00:31:00Z"))?.toISOString(),
    "2026-09-15T16:30:00.000Z",
  );
});

test("okna a stropy se počítají v UTC, ne v místním čase", () => {
  const now = new Date("2026-09-15T23:30:00Z");
  assert.equal(startOfUtcDayIso(now), "2026-09-15T00:00:00.000Z");
  assert.equal(startOfUtcMonthIso(now), "2026-09-01T00:00:00.000Z");
  assert.deepEqual(lastUtcDays(3, now), ["2026-09-13", "2026-09-14", "2026-09-15"]);
});
