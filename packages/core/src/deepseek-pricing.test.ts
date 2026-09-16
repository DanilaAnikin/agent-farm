import test from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_MODEL_BY_ALIAS,
  DEEPSEEK_PRICES,
  deepseekChargeUsd,
  deepseekPeakOverlaps,
  deepseekPriceTier,
  deepseekReservationTier,
  deepseekReservationUsd,
  isDeepseekPeakUtc,
  normalizeDeepseekModel,
  repricedSpendUsd,
} from "./deepseek-pricing.js";

// 2026-09-16 je středa, 09-18 pátek, 09-19/20 víkend, 09-21 pondělí.
const utc = (text: string) => new Date(`${text}Z`);

test("špička jsou jen pracovní dny 01–04 a 06–10 UTC", () => {
  for (const t of ["2026-09-16T01:00:00", "2026-09-16T03:59:59", "2026-09-16T06:00:00",
                   "2026-09-16T09:59:59", "2026-09-18T01:00:00"]) {
    assert.equal(isDeepseekPeakUtc(utc(t)), true, t);
  }
  for (const t of ["2026-09-16T00:59:59", "2026-09-16T04:00:00", "2026-09-16T05:59:59",
                   "2026-09-16T10:00:00", "2026-09-16T23:30:00",
                   "2026-09-19T02:00:00", "2026-09-20T07:00:00"]) {
    assert.equal(isDeepseekPeakUtc(utc(t)), false, t);
  }
});

test("mimo špičku jen tehdy, když celý požadavek i s driftem mine špičku", () => {
  assert.equal(deepseekPriceTier(utc("2026-09-16T04:10:00"), utc("2026-09-16T05:40:00")), "offpeak");
  assert.equal(deepseekPriceTier(utc("2026-09-16T05:50:00"), utc("2026-09-16T05:59:00")), "peak");
  assert.equal(deepseekPriceTier(utc("2026-09-16T00:40:00"), utc("2026-09-16T00:50:00")), "offpeak");
  // Rezerva na drift je přesně 120 s: konec v 00:57 se do 01:00 ještě vejde, 00:59 už ne.
  assert.equal(deepseekPriceTier(utc("2026-09-16T00:50:00"), utc("2026-09-16T00:57:00")), "offpeak");
  assert.equal(deepseekPriceTier(utc("2026-09-16T00:50:00"), utc("2026-09-16T00:59:00")), "peak");
  // Požadavek začatý mimo špičku a dokončený ve špičce se účtuje jako špička.
  assert.equal(deepseekPriceTier(utc("2026-09-16T00:55:00"), utc("2026-09-16T01:02:00")), "peak");
  // Přes půlnoc a přes víkend.
  assert.equal(deepseekPriceTier(utc("2026-09-16T23:00:00"), utc("2026-09-17T00:30:00")), "offpeak");
  assert.equal(deepseekPriceTier(utc("2026-09-18T23:00:00"), utc("2026-09-19T05:00:00")), "offpeak");
  assert.equal(deepseekPriceTier(utc("2026-09-20T23:00:00"), utc("2026-09-21T01:30:00")), "peak");
});

test("nejistý vstup je vždy špička, sleva se z něj nikdy nevyrobí", () => {
  assert.equal(deepseekPriceTier(utc("2026-09-16T12:00:00"), utc("2026-09-16T11:00:00")), "peak");
  assert.equal(deepseekPriceTier(utc("2026-09-16T12:00:00"), utc("2026-10-16T12:00:00")), "peak");
  assert.equal(deepseekPriceTier(new Date(Number.NaN), utc("2026-09-16T12:00:00")), "peak");
  assert.equal(deepseekPeakOverlaps(new Date(Number.NaN), new Date(Number.NaN)), true);
});

test("rezervace počítá s nejdelším možným během požadavku", () => {
  assert.equal(deepseekReservationTier(utc("2026-09-16T00:45:00")), "peak");
  assert.equal(deepseekReservationTier(utc("2026-09-16T00:20:00")), "offpeak");
  assert.equal(deepseekReservationTier(utc("2026-09-19T00:45:00")), "offpeak"); // sobota
});

test("ceník: mimo špičku je přesně polovina a aliasy sedí na ceník hlídače", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro"] as const) {
    const peak = DEEPSEEK_PRICES.peak[model];
    const off = DEEPSEEK_PRICES.offpeak[model];
    assert.equal(off.inputUsdPerM * 2, peak.inputUsdPerM);
    assert.equal(off.outputUsdPerM * 2, peak.outputUsdPerM);
    assert.ok(Math.abs(off.cachedInputUsdPerM * 2 - peak.cachedInputUsdPerM) < 1e-12);
  }
  assert.equal(DEEPSEEK_MODEL_BY_ALIAS.worker, "deepseek-flash");
  assert.equal(DEEPSEEK_MODEL_BY_ALIAS.cheap, "deepseek-flash");
  for (const alias of ["manager", "judge", "worker-hard", "worker-fallback", "media-vlm"]) {
    assert.equal(DEEPSEEK_MODEL_BY_ALIAS[alias], "deepseek-v4-pro", alias);
  }
});

test("cena požadavku: cache sleva jen na věrohodný počet zásahů", () => {
  const peak = deepseekChargeUsd({ model: "deepseek-flash", tokensIn: 1000, tokensOut: 200, tier: "peak" });
  const off = deepseekChargeUsd({ model: "deepseek-flash", tokensIn: 1000, tokensOut: 200, tier: "offpeak" });
  assert.ok(Math.abs(peak - 0.00054) < 1e-12);
  assert.ok(Math.abs(off - 0.00027) < 1e-12);
  // Nesmyslný počet zásahů cache slevu nedostane (stejně jako v hlídači).
  const bogus = deepseekChargeUsd({ model: "deepseek-flash", tokensIn: 1000, tokensOut: 200, cachedTokens: 5000, tier: "peak" });
  assert.equal(bogus, peak);
  const cached = deepseekChargeUsd({ model: "deepseek-flash", tokensIn: 1000, tokensOut: 200, cachedTokens: 1000, tier: "peak" });
  assert.ok(cached < peak);
});

test("normalizace názvu modelu z odpovědi Flash i Pro", () => {
  for (const name of ["deepseek-flash", "deepseek/deepseek-flash", "deepseek-v4-flash", "deepseek/deepseek-v4.1-flash"]) {
    assert.equal(normalizeDeepseekModel(name), "deepseek-flash", name);
  }
  assert.equal(normalizeDeepseekModel("deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
  for (const name of ["worker", "deepseek-chat", "", null, undefined]) {
    assert.equal(normalizeDeepseekModel(name), null, String(name));
  }
});

test("přepočet spend-logu: mimo špičku polovina, neznámý model drží číslo z LiteLLM", () => {
  const log = { model: "deepseek/deepseek-flash", tokensIn: 1000, tokensOut: 200, litellmSpendUsd: 0.00027 };
  const off = repricedSpendUsd({ ...log, start: utc("2026-09-16T23:00:00"), end: utc("2026-09-16T23:00:05") });
  const peak = repricedSpendUsd({ ...log, start: utc("2026-09-16T01:10:00"), end: utc("2026-09-16T01:10:05") });
  assert.ok(Math.abs(off - 0.00027) < 1e-12);
  assert.ok(Math.abs(peak - 0.00054) < 1e-12);
  // Požadavek přes hranici okna se přepočte jako špička.
  assert.ok(Math.abs(repricedSpendUsd({ ...log, start: utc("2026-09-16T00:58:00"), end: utc("2026-09-16T01:01:00") }) - 0.00054) < 1e-12);
  // Neznámý model a řádek bez tokenů nikdy nepodhodnotí útratu z LiteLLM.
  assert.equal(repricedSpendUsd({ ...log, model: "glm-4.6", start: utc("2026-09-16T23:00:00"), end: utc("2026-09-16T23:00:05") }), 0.00027);
  assert.equal(repricedSpendUsd({ ...log, tokensIn: 0, tokensOut: 0, litellmSpendUsd: 0.004, start: utc("2026-09-16T23:00:00"), end: utc("2026-09-16T23:00:05") }), 0.004);
});

test("rezervace kontextu workera: Flash mimo špičku je zlomek ceny Pro ve špičce", () => {
  const proPeak = deepseekReservationUsd({ contextBytes: 140_000, model: "deepseek-v4-pro", tier: "peak" });
  const flashOff = deepseekReservationUsd({ contextBytes: 140_000, model: "deepseek-flash", tier: "offpeak" });
  assert.ok(Math.abs(proPeak - 0.20166) < 0.0001, String(proPeak));
  assert.ok(Math.abs(flashOff - 0.0235284) < 0.0001, String(flashOff));
  assert.ok(flashOff < proPeak);
  // Nesmyslný kontext nesmí rezervaci srazit pod cenu samotného výstupu.
  assert.ok(deepseekReservationUsd({ contextBytes: Number.NaN, model: "deepseek-flash", tier: "peak" }) > 0);
});
