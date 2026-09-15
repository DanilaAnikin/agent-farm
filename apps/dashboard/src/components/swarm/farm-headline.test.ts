import assert from "node:assert/strict";
import { test } from "node:test";
import { farmState } from "../../lib/farm-state";
import { currentOffpeakStart, farmHeadline, farmShortReason } from "./farm-headline";

test("krátký důvod na kartu projektu", () => {
  const poledne = new Date("2026-09-15T12:00:00Z");
  assert.equal(farmShortReason(farmState({}, poledne)), null);
  assert.equal(farmShortReason(farmState({ guard_ready: false }, poledne)), "zamčený rozpočtový hlídač");
  assert.equal(farmShortReason(farmState({ owner_pause: true }, poledne)), "pozastavil ji majitel");
  assert.equal(
    farmShortReason(farmState({ global_pause: true, pause_source: "offpeak" }, poledne)),
    "drahé hodiny, sama se rozjede v 18:30",
  );
  assert.equal(
    farmShortReason(farmState({ global_pause: true, pause_source: "credit" }, poledne)),
    "došel kredit u poskytovatele",
  );
});

// 12:00 UTC = špička (levné okno 16:30–00:30 UTC)
const POLEDNE = new Date("2026-09-15T12:00:00Z");
// 20:00 UTC = uvnitř levného okna
const VECER = new Date("2026-09-15T20:00:00Z");

test("owner pause: věta o majiteli a frontě aktivních projektů", () => {
  const h = farmHeadline({
    state: farmState({ owner_pause: true }, POLEDNE),
    busyAgents: 0,
    queuedActive: 2,
    now: POLEDNE,
  });
  assert.equal(h.title, "Farma je pozastavená majitelem");
  assert.match(h.detail, /čekají 2 úkoly/);
});

test("zamčený hlídač: „zablokoval nové požadavky od …“", () => {
  const h = farmHeadline({
    state: farmState({ guard_ready: false }, POLEDNE),
    busyAgents: 0,
    queuedActive: 0,
    sinceIso: "2026-09-14T22:19:00Z",
    now: POLEDNE,
  });
  assert.match(h.title, /^Rozpočtový hlídač zablokoval nové požadavky od 15\. 9\. 2026 0:19|^Rozpočtový hlídač zablokoval nové požadavky od 15\. 9\. 2026 00:19/);
  assert.equal(h.tone, "danger");
});

test("drahé hodiny: sama se rozjede v HH:MM (Praha)", () => {
  const h = farmHeadline({
    state: farmState({ global_pause: true, pause_source: "offpeak" }, POLEDNE),
    busyAgents: 0,
    queuedActive: 0,
    now: POLEDNE,
  });
  // 16:30 UTC = 18:30 SELČ
  assert.equal(h.title, "Drahé hodiny DeepSeeku — farma se sama rozjede v 18:30");
  assert.match(h.detail, /Za 4 h 30 min/);
});

test("pauza v levném okně: plánovač ji měl pustit a nepustil", () => {
  const h = farmHeadline({
    state: farmState({ global_pause: true, pause_source: "offpeak" }, VECER),
    busyAgents: 0,
    queuedActive: 0,
    now: VECER,
  });
  assert.equal(h.title, "Plánovač měl farmu pustit v 18:30 a nepustil");
  assert.equal(h.tone, "danger");
});

test("běží bez práce / s prací / s agenty", () => {
  const bezi = farmState({}, POLEDNE);
  assert.equal(
    farmHeadline({ state: bezi, busyAgents: 0, queuedActive: 0 }).title,
    "Farma běží a nemá práci — sama si ji doplní",
  );
  assert.equal(
    farmHeadline({ state: bezi, busyAgents: 0, queuedActive: 1 }).title,
    "Farma běží, 1 úkol čeká na volný slot",
  );
  assert.equal(
    farmHeadline({ state: bezi, busyAgents: 2, queuedActive: 0 }).title,
    "Farma běží — 2 agenti pracují",
  );
  assert.equal(
    farmHeadline({ state: bezi, busyAgents: 1, queuedActive: 0 }).title,
    "Farma běží — 1 agent pracuje",
  );
});

test("začátek aktuálního levného okna i přes půlnoc", () => {
  assert.equal(currentOffpeakStart(VECER)?.toISOString(), "2026-09-15T16:30:00.000Z");
  assert.equal(
    currentOffpeakStart(new Date("2026-09-16T00:10:00Z"))?.toISOString(),
    "2026-09-15T16:30:00.000Z",
  );
  assert.equal(currentOffpeakStart(POLEDNE), null);
});
