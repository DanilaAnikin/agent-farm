import assert from "node:assert/strict";
import { test } from "node:test";
import { farmState, nextUtcMidnight } from "./farm-state";
import { farmHeadline, farmShortReason } from "../components/swarm/farm-headline";
import { budgetWidget, farmSpend, spendSourceLabel } from "./budget-widget";
import { formatAtTime } from "./format";
import type { BudgetSnapshot } from "./rpc";

// Stav produkce 15. 9. 2026 večer: ripieno a ivanweb v budget_hold s 1 úkolem ve frontě,
// contentgen aktivní bez práce, farma nepozastavená, hlídač připravený.
const VECER = new Date("2026-09-15T19:35:00Z");
const PRODUKCE = {
  owner_pause: false,
  global_pause: false,
  pause_source: null,
  budget_block: false,
  guard_ready: true,
  budget_hold_projects: 2,
  budget_hold_queued: 2,
  budget_hold_since: "2026-09-15T18:40:12.519Z",
  // Obě události budget_hold mají data->>scope = project (denní strop).
  budget_hold_reasons: { day: 2, month: 0, credits: 0, other: 0 },
  active_work: 0,
};

test("formatAtTime: předložka podle hodiny", () => {
  assert.equal(formatAtTime("2026-09-16T00:00:00Z"), "ve 02:00");
  assert.equal(formatAtTime("2026-09-15T16:30:00Z"), "v 18:30");
  assert.equal(formatAtTime("2026-09-15T10:00:00Z"), "ve 12:00");
  assert.equal(formatAtTime("2026-12-16T00:00:00Z"), "v 01:00");
  assert.equal(formatAtTime(null), "—");
});

test("nextUtcMidnight: přetočení dne i měsíce", () => {
  assert.equal(nextUtcMidnight(VECER).toISOString(), "2026-09-16T00:00:00.000Z");
  assert.equal(nextUtcMidnight(new Date("2026-09-30T23:59:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("budget_wait: práce čeká na rozpočet → ne „běží a nemá práci“", () => {
  const s = farmState(PRODUKCE, VECER);
  assert.equal(s.code, "budget_wait");
  assert.equal(s.paused, false);
  assert.equal(s.title, "Farma čeká na rozpočet");
  assert.equal(s.nextResumeAt, "2026-09-16T00:00:00.000Z");
  assert.equal(
    s.detail,
    "2 projekty čekají na nový rozpočtový den (ve frontě 2 úkoly). Farma pokračuje sama ve 02:00 (Europe/Prague), po přetočení denního stropu o půlnoci UTC.",
  );
  assert.equal(farmShortReason(s), null);

  const h = farmHeadline({ state: s, busyAgents: 0, queuedActive: 0, now: VECER });
  assert.equal(h.title, "2 projekty čekají na nový rozpočtový den — farma pokračuje sama ve 02:00");
  assert.doesNotMatch(h.title, /nemá práci/);
  assert.equal(
    h.detail,
    "Ve frontě čekají 2 úkoly. Do přetočení denního stropu o půlnoci UTC na nich farma nepracuje, pak pokračuje sama.",
  );
  assert.equal(h.tone, "info");
});

test("budget_wait: plurály pro 1 projekt a prázdnou frontu", () => {
  const s = farmState(
    { ...PRODUKCE, budget_hold_projects: 1, budget_hold_queued: 0, budget_hold_reasons: { day: 1, month: 0, credits: 0, other: 0 } },
    VECER,
  );
  assert.match(s.detail, /^1 projekt čeká na nový rozpočtový den\. /);
  const h = farmHeadline({ state: s, busyAgents: 0, queuedActive: 0, now: VECER });
  assert.equal(h.title, "1 projekt čeká na nový rozpočtový den — farma pokračuje sama ve 02:00");
  assert.match(h.detail, /^Do přetočení/);
});

test("budget_wait: den se už přetočil → žádný čas zítra, ale „během několika minut“", () => {
  const poPulnoci = new Date("2026-09-16T00:02:00Z");
  const s = farmState(PRODUKCE, poPulnoci);
  assert.equal(s.code, "budget_wait");
  assert.equal(s.nextResumeAt, null);
  assert.match(s.detail, /během několika minut/);
  const h = farmHeadline({ state: s, busyAgents: 0, queuedActive: 0, now: poPulnoci });
  assert.equal(h.title, "Rozpočtový den se přetočil — farma vrací projekty do práce");
});

test("budget_wait: „během několika minut“ jen do 10 minut po půlnoci, pak neutrálně", () => {
  const pozde = new Date("2026-09-16T00:30:00Z");
  const s = farmState(PRODUKCE, pozde);
  assert.equal(s.code, "budget_wait");
  assert.equal(s.budgetWaitKind, "waiting");
  assert.equal(s.nextResumeAt, null);
  assert.doesNotMatch(s.detail, /několika minut|02:00/);
  assert.equal(s.detail, "2 projekty čekají na rozpočet (ve frontě 2 úkoly). Farma je vrátí do práce, až to rozpočet dovolí.");
  const h = farmHeadline({ state: s, busyAgents: 0, queuedActive: 0, now: pozde });
  assert.equal(h.title, "2 projekty čekají na rozpočet");
  // Hranice okna: přesně 10 minut ještě platí.
  assert.equal(farmState(PRODUKCE, new Date("2026-09-16T00:10:00Z")).budgetWaitKind, "day_rolled");
});

test("budget_wait: měsíční strop ani kredity o půlnoci neslibují pokračování", () => {
  const mesic = farmState({ ...PRODUKCE, budget_hold_reasons: { day: 0, month: 2, credits: 0, other: 0 } }, VECER);
  assert.equal(mesic.code, "budget_wait");
  assert.equal(mesic.nextResumeAt, null);
  assert.doesNotMatch(mesic.detail, /02:00|několika minut|půlnoci/);
  assert.match(mesic.detail, /^2 projekty čekají na nový měsíc \(ve frontě 2 úkoly\)\. Měsíční strop farmy je vyčerpaný/);
  assert.equal(
    farmHeadline({ state: mesic, busyAgents: 0, queuedActive: 0, now: VECER }).title,
    "2 projekty čekají na nový měsíc — měsíční strop farmy je vyčerpaný",
  );
  // Po půlnoci UTC měsíční strop dál drží → žádné „během několika minut“.
  const mesicPoPulnoci = farmState(
    { ...PRODUKCE, budget_hold_reasons: { day: 0, month: 2, credits: 0, other: 0 } },
    new Date("2026-09-16T00:02:00Z"),
  );
  assert.doesNotMatch(mesicPoPulnoci.detail, /několika minut/);

  const kredity = farmState({ ...PRODUKCE, budget_hold_projects: 1, budget_hold_reasons: { day: 0, month: 0, credits: 1, other: 0 } }, VECER);
  assert.equal(kredity.budgetWaitKind, "credits");
  assert.match(kredity.detail, /^1 projekt čeká na navýšení kreditů/);
  assert.doesNotMatch(kredity.detail, /02:00/);
  assert.equal(farmHeadline({ state: kredity, busyAgents: 0, queuedActive: 0, now: VECER }).title, "1 projekt čeká na navýšení kreditů");
});

test("budget_wait: smíšené nebo neznámé důvody → rozpis bez slibu času", () => {
  const smisene = farmState({ ...PRODUKCE, budget_hold_reasons: { day: 1, month: 1, credits: 0, other: 0 } }, VECER);
  assert.equal(smisene.budgetWaitKind, "waiting");
  assert.equal(smisene.nextResumeAt, null);
  assert.equal(
    smisene.detail,
    "2 projekty čekají na rozpočet (ve frontě 2 úkoly). Důvody: denní strop 1 projekt, měsíční strop farmy 1 projekt. Farma je vrátí do práce, až to rozpočet dovolí.",
  );
  // Dashboard proti staré funkci bez důvodů: nevíme proč → neslibujeme „ve 02:00“.
  const bezDuvodu = farmState({ ...PRODUKCE, budget_hold_reasons: undefined }, VECER);
  assert.equal(bezDuvodu.code, "budget_wait");
  assert.equal(bezDuvodu.nextResumeAt, null);
  assert.doesNotMatch(bezDuvodu.detail, /02:00/);
});

test("budget_wait se neukáže, když aktivní projekty mají práci, nic nečeká nebo data chybí", () => {
  assert.equal(farmState({ ...PRODUKCE, active_work: 3 }, VECER).code, "running");
  assert.equal(farmState({ ...PRODUKCE, budget_hold_projects: 0 }, VECER).code, "running");
  // Záložní čtení bez RPC 0017: počty neznáme → nic si nevymýšlíme.
  assert.equal(farmState({ ...PRODUKCE, budget_hold_projects: undefined, active_work: undefined }, VECER).code, "running");
  assert.equal(farmState({ ...PRODUKCE, active_work: null }, VECER).code, "running");
});

test("budget_wait nepřebije pauzu ani zamčený hlídač", () => {
  assert.equal(farmState({ ...PRODUKCE, owner_pause: true }, VECER).code, "owner");
  assert.equal(farmState({ ...PRODUKCE, guard_ready: false }, VECER).code, "budget");
  assert.equal(farmState({ ...PRODUKCE, global_pause: true, pause_source: "offpeak" }, new Date("2026-09-15T10:00:00Z")).code, "offpeak_expected");
});

// --- jedno měsíční číslo ---------------------------------------------------------

function snapshot(castecny: Partial<BudgetSnapshot>): BudgetSnapshot {
  return {
    admin: true,
    day_settled: 0.3966,
    month_settled: 2.4,
    day_counted: 0.3967,
    month_counted: 5.89,
    day_reserved: 0,
    ready: true,
    ready_since: null,
    deepseek_balance_usd: 3.61,
    day_start_utc: null,
    month_start_utc: null,
    ...castecny,
  };
}

test("farmSpend: pás i hlavička berou započtené číslo hlídače, ne změřené", () => {
  const ledger = { day: 0.3966, month: 2.4 };
  const s = farmSpend({ isAdmin: true, snapshot: snapshot({}), ledger });
  assert.equal(s.source, "guard");
  assert.equal(s.month, 5.89);
  const w = budgetWidget({ isAdmin: true, snapshot: snapshot({}), ledger, caps: { dailyUsd: 0.6, monthlyUsd: 20 }, now: VECER });
  assert.equal(w.month, s.month);
  assert.equal(w.day, s.day);
  assert.match(spendSourceLabel(s.source), /hlídačem/);
});

test("farmSpend: člen a nedostupný hlídač → pohyby, pojmenované jako pohyby", () => {
  const ledger = { day: 0.1, month: 2.4 };
  const clen = farmSpend({ isAdmin: false, snapshot: null, ledger });
  assert.deepEqual([clen.source, clen.month, clen.warning], ["ledger", 2.4, null]);
  assert.equal(spendSourceLabel(clen.source), "započteno z pohybů");
  const bezHlidace = farmSpend({ isAdmin: true, snapshot: snapshot({ ready: null, month_settled: 2.5 }), ledger });
  assert.equal(bezHlidace.source, "ledger");
  assert.equal(bezHlidace.month, 2.5);
  assert.match(bezHlidace.warning ?? "", /hlídač neodpovídá/);
});
