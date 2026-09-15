import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetWidget, endOfUtcDay, sumCostSummary } from "./budget-widget";
import type { BudgetSnapshot } from "./rpc";

// Letní čas: UTC půlnoc = 02:00 v Praze.
const LETO = new Date("2026-09-15T10:00:00Z");
const ZIMA = new Date("2026-12-15T10:00:00Z");
const CAPS = { dailyUsd: 0.6, monthlyUsd: 20 };

function snapshot(castecny: Partial<BudgetSnapshot>): BudgetSnapshot {
  return {
    admin: true,
    day_settled: 0,
    month_settled: 0,
    day_counted: null,
    month_counted: null,
    day_reserved: null,
    ready: true,
    ready_since: null,
    deepseek_balance_usd: null,
    day_start_utc: null,
    month_start_utc: null,
    ...castecny,
  };
}

test("sumCostSummary: dnešek podle UTC dne, měsíc = všechno", () => {
  const r = sumCostSummary(
    [
      { day: "2026-09-15", cost_usd: 0.1 },
      { day: "2026-09-15", cost_usd: 0.05 },
      { day: "2026-09-14", cost_usd: 1 },
    ],
    LETO,
  );
  assert.ok(Math.abs(r.day - 0.15) < 1e-9);
  assert.ok(Math.abs(r.month - 1.15) < 1e-9);
});

test("endOfUtcDay: další UTC půlnoc", () => {
  assert.equal(endOfUtcDay(LETO).toISOString(), "2026-09-16T00:00:00.000Z");
});

test("admin s hlídačem: bere max(hlídač, ledger) a rezervaci", () => {
  const w = budgetWidget({
    isAdmin: true,
    snapshot: snapshot({ day_settled: 0.1, day_counted: 0.31, month_settled: 5.49, month_counted: 5.2, day_reserved: 0.12 }),
    ledger: { day: null, month: null },
    caps: CAPS,
    now: LETO,
  });
  assert.equal(w.source, "guard");
  assert.equal(w.day, 0.31);
  assert.equal(w.month, 5.49);
  assert.equal(w.dayText, "0,31 / 0,60 US$");
  assert.equal(w.monthText, "5,49 / 20,00 US$");
  assert.match(w.reservedText ?? "", /rezervováno 0,12/);
  assert.equal(w.warning, null);
  // 0,31/0,60 ≈ 52 % > 5,49/20 ≈ 27 % → bar ukazuje den
  assert.equal(w.nearer, "day");
  assert.equal(w.compactText, "0,31/0,60 US$");
  assert.match(w.title, /Zdroj: rozpočtový hlídač · den končí ve 02:00 \(Europe\/Prague\)/);
});

test("zimní čas: den končí v 01:00", () => {
  const w = budgetWidget({ isAdmin: true, snapshot: snapshot({}), ledger: { day: 0, month: 0 }, caps: CAPS, now: ZIMA });
  assert.match(w.title, /ve 01:00/);
});

test("bar jde za limitem, který je blíž vyčerpání", () => {
  const w = budgetWidget({
    isAdmin: true,
    snapshot: snapshot({ day_counted: 0.06, month_counted: 18 }),
    ledger: { day: null, month: null },
    caps: CAPS,
    now: LETO,
  });
  assert.equal(w.nearer, "month");
  assert.ok(Math.abs(w.ratio - 0.9) < 1e-9);
  assert.equal(w.compactText, "18,00/20,00 US$");
});

test("hlídač nedostupný (ready null): nula se nevydává za pravdu", () => {
  const w = budgetWidget({
    isAdmin: true,
    snapshot: snapshot({ ready: null, day_settled: 0, month_settled: 5.49 }),
    ledger: { day: null, month: null },
    caps: CAPS,
    now: LETO,
  });
  assert.equal(w.source, "ledger");
  assert.match(w.warning ?? "", /hlídač neodpovídá/);
  assert.match(w.title, /hlídač neodpovídá/);
  assert.match(w.ariaLabel, /hlídač neodpovídá/);
  assert.equal(w.reservedText, null);
});

test("člen: jen pohyby a popisek „započteno z pohybů“, bez varování", () => {
  const w = budgetWidget({
    isAdmin: false,
    snapshot: { ...snapshot({}), admin: false },
    ledger: { day: 0.002, month: 1 },
    caps: CAPS,
    now: LETO,
  });
  assert.equal(w.source, "ledger");
  assert.equal(w.sourceLabel, "započteno z pohybů");
  assert.equal(w.warning, null);
  // drobná útrata není „0,00"
  assert.equal(w.dayText, "< 0,01 / 0,60 US$");
});

test("admin bez snapshotu: varování, čísla z pohybů", () => {
  const w = budgetWidget({ isAdmin: true, snapshot: null, ledger: { day: 0.2, month: 3 }, caps: CAPS, now: LETO });
  assert.equal(w.source, "ledger");
  assert.match(w.warning ?? "", /nepodařilo načíst/);
});

test("nic nenačteno: pomlčky, ne nuly", () => {
  const w = budgetWidget({ isAdmin: false, snapshot: null, ledger: { day: null, month: null }, caps: CAPS, now: LETO });
  assert.equal(w.dayText, "— / 0,60 US$");
  assert.equal(w.ratio, 0);
  assert.match(w.warning ?? "", /nepodařilo/);
  assert.match(w.ariaLabel, /neznámá/);
});
