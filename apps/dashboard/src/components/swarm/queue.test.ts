import assert from "node:assert/strict";
import { test } from "node:test";
import {
  progressBreakdown,
  projectProgress,
  queueBreakdown,
  queueHeadline,
  queueSubline,
  queueTone,
  wishBreakdown,
  wishBreakdownLine,
  type TaskRollupInput,
} from "./queue";

function radek(p: Partial<TaskRollupInput>): TaskRollupInput {
  return {
    project_id: "p",
    project_status: "active",
    queued: 0,
    running: 0,
    judging: 0,
    merging: 0,
    done: 0,
    failed: 0,
    parked_live: 0,
    parked_archived: 0,
    last_activity: null,
    ...p,
  };
}

// Stav produkce z auditu: aktivní projekty 2 queued, pozastavené 100 queued.
const PRODUKCE = [
  radek({ project_id: "ripieno", queued: 2, judging: 1, done: 31, parked_archived: 121 }),
  radek({ project_id: "explain", project_status: "paused", queued: 100, parked_archived: 22 }),
];

test("fronta: hlavní číslo jen z aktivních projektů, pozastavené do podřádku", () => {
  const b = queueBreakdown(PRODUKCE);
  assert.equal(b.queuedActive, 2);
  assert.equal(b.queuedPaused, 100);
  assert.equal(queueHeadline(b), "2 úkoly čekají (aktivní projekty)");
  assert.equal(queueSubline(b), "1 u soudce · 100 v pozastavených projektech");
});

test("fronta: bigint jako řetězec i null se čte bezpečně", () => {
  const b = queueBreakdown([radek({ queued: "5", running: null })]);
  assert.equal(b.queuedActive, 5);
  assert.equal(b.runningActive, 0);
  assert.equal(queueHeadline(b), "5 úkolů čeká (aktivní projekty)");
  assert.equal(queueHeadline(queueBreakdown([radek({ queued: 1 })])), "1 úkol čeká (aktivní projekty)");
});

test("fronta: prázdný podřádek je null", () => {
  assert.equal(queueSubline(queueBreakdown([radek({ queued: 3 })])), null);
});

test("tón fronty: warn jen když farma běží, čeká práce a nikdo nepracuje", () => {
  const b = queueBreakdown([radek({ queued: 2 })]);
  assert.equal(queueTone(b, { farmRunning: true, busyAgents: 0 }), "warn");
  assert.equal(queueTone(b, { farmRunning: false, busyAgents: 0 }), "default");
  assert.equal(queueTone(b, { farmRunning: true, busyAgents: 1 }), "default");
  // plná fronta pozastaveného projektu není poplach
  const jenPozastavene = queueBreakdown([radek({ project_status: "paused", queued: 100 })]);
  assert.equal(queueTone(jenPozastavene, { farmRunning: true, busyAgents: 0 }), "default");
  // soudce pracuje → nic nevisí
  const uSoudce = queueBreakdown([radek({ queued: 2, judging: 1 })]);
  assert.equal(queueTone(uSoudce, { farmRunning: true, busyAgents: 0 }), "default");
});

test("postup: archiv se do celku nepočítá (ripieno 31/33, ne 31/154)", () => {
  const p = projectProgress(PRODUKCE[0]);
  assert.equal(p.denominator, 34);
  assert.equal(Math.round(p.ratio * 100), 91);
  assert.equal(progressBreakdown(p), "31 hotovo · 3 rozpracováno · 121 v archivu");
});

test("postup: projekt bez úkolů má 0 a nedělí nulou", () => {
  const p = projectProgress(undefined);
  assert.equal(p.ratio, 0);
  assert.equal(progressBreakdown(p), "0 hotovo");
  assert.equal(projectProgress(radek({ parked_archived: 40 })).ratio, 0);
});

test("otevřená přání: rozpad aktivní vs. pozastavené", () => {
  const b = wishBreakdown([
    { project_id: "a", project_status: "active", status: "active", cnt: 1 },
    { project_id: "b", project_status: "paused", status: "active", cnt: 27 },
  ]);
  assert.equal(b.openActive, 1);
  assert.equal(b.openPaused, 27);
  assert.equal(b.openByProject.get("b"), 27);
  assert.equal(wishBreakdownLine(b), "1 rozpracované · 27 čeká v pozastavených projektech");
  // Sloveso musí souhlasit s číslem i u 2–4.
  assert.equal(
    wishBreakdownLine({ openActive: 0, openPaused: 3, openByProject: new Map() }),
    "0 rozpracovaných · 3 čekají v pozastavených projektech",
  );
});

test("fronta: sloveso u 2–4 v množném čísle („2 se slučují“)", () => {
  const prazdna = {
    queuedActive: 0,
    runningActive: 0,
    judgingActive: 0,
    mergingActive: 0,
    queuedPaused: 0,
    parkedLive: 0,
    parkedArchived: 0,
  };
  assert.equal(queueSubline({ ...prazdna, mergingActive: 2 }), "2 se slučují");
  assert.equal(queueSubline({ ...prazdna, mergingActive: 1 }), "1 se slučuje");
  assert.equal(queueSubline({ ...prazdna, mergingActive: 5 }), "5 se slučuje");
  assert.equal(queueHeadline({ ...prazdna, queuedActive: 3 }), "3 úkoly čekají (aktivní projekty)");
  assert.equal(
    wishBreakdownLine(wishBreakdown([{ project_id: "a", project_status: "active", status: "new", cnt: "3" }])),
    "3 rozpracovaná",
  );
});
