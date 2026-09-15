import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_TIME_ZONE,
  formatBytes,
  formatDate,
  formatDateShort,
  formatDayShort,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTimeShort,
  formatUsd,
  formatUsdAxis,
  spendRatio,
} from "./format";

// Nedělitelná mezera, kterou Intl v cs-CZ vkládá mezi číslo a jednotku/měnu.
const NBSP = " ";

test("formatUsd: české peníze, ne americké", () => {
  assert.equal(formatUsd(0.6, "cap"), `0,60${NBSP}US$`);
  assert.equal(formatUsd(20, "cap"), `20,00${NBSP}US$`);
  assert.equal(formatUsd(5.4912), `5,49${NBSP}US$`);
});

test("formatUsd: 'precise' drží pevně čtyři místa", () => {
  assert.equal(formatUsd(1.23456, "precise"), `1,2346${NBSP}US$`);
  assert.equal(formatUsd(2, "precise"), `2,0000${NBSP}US$`);
});

test("formatUsd: drobná útrata se nesmí tvářit jako nula", () => {
  // 0,0004 US$ zaokrouhlené na 0,00 by tvrdilo, že se neutratilo nic.
  assert.equal(formatUsd(0.0004), `< 0,01${NBSP}US$`);
  assert.equal(formatUsd(0.0049), `< 0,01${NBSP}US$`);
  assert.equal(formatUsd(-0.0004), `> −0,01${NBSP}US$`);
  // Přesná nula je pravda, tu neschováváme.
  assert.equal(formatUsd(0), `0,00${NBSP}US$`);
  // Od půl centu výš už se zaokrouhluje normálně.
  assert.equal(formatUsd(0.005), `0,01${NBSP}US$`);
});

test("formatUsd: nesmysly nepadají, berou se jako nula", () => {
  assert.equal(formatUsd(null), `0,00${NBSP}US$`);
  assert.equal(formatUsd(undefined), `0,00${NBSP}US$`);
  assert.equal(formatUsd(Number.NaN), `0,00${NBSP}US$`);
});

test("formatUsdAxis: osa grafu je bez měny", () => {
  assert.equal(formatUsdAxis(0.6), "0,60");
  assert.ok(!formatUsdAxis(1).includes("$"));
});

test("formatPercent: v češtině s mezerou", () => {
  assert.equal(formatPercent(0.2), `20${NBSP}%`);
  assert.equal(formatPercent(1), `100${NBSP}%`);
  assert.equal(formatPercent(null), `0${NBSP}%`);
});

test("formatNumber: tisíce po česku", () => {
  assert.equal(formatNumber(1234567).replace(/\s/g, " "), "1 234 567");
  assert.equal(formatNumber(null), "0");
});

test("formatBytes: nejvýš jedno desetinné místo", () => {
  assert.equal(formatBytes(0), "—");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1,5 kB");
  assert.equal(formatBytes(1024 * 1024 * 3), "3 MB");
});

test("formatDuration: čitelně, ne jako čas na stopkách", () => {
  assert.equal(formatDuration(45), "45 s");
  assert.equal(formatDuration(65), "1 min 5 s");
  assert.equal(formatDuration(120), "2 min");
  assert.equal(formatDuration(3900), "1 h 5 min");
  assert.equal(formatDuration(7200), "2 h");
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(null), "—");
});

test("časy se zobrazují v Europe/Prague, ne v UTC kontejneru", () => {
  assert.equal(APP_TIME_ZONE, "Europe/Prague");
  // 2026-09-14 23:30 UTC je v Praze už 15. 9. (letní čas, +2).
  const d = "2026-09-14T23:30:00Z";
  assert.equal(formatDateShort(d), "15. 9.");
  assert.equal(formatTimeShort(d), "01:30");
  assert.match(formatDate(d), /15\. 9\. 2026/);
});

test("formatDayShort bere i klíč dne z lastUtcDays", () => {
  assert.equal(formatDayShort("2026-09-14"), "14. 9.");
});

test("prázdné a nevalidní datum nikdy nespadne", () => {
  for (const f of [formatDate, formatDateShort, formatDayShort, formatTimeShort]) {
    assert.equal(f(null), "—");
    assert.equal(f(undefined), "—");
    assert.equal(f(""), "—");
    assert.equal(f("nesmysl"), "—");
  }
  assert.equal(formatRelative(null), "—");
});

test("formatRelative: relativní čas se počítá proti předanému 'now'", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  assert.equal(formatRelative("2026-09-15T11:59:58Z", now), "právě teď");
  assert.equal(formatRelative("2026-09-15T11:59:00Z", now), "před 1 minutou");
  assert.equal(formatRelative("2026-09-15T09:00:00Z", now), "před 3 hodinami");
  assert.equal(formatRelative("2026-09-14T12:00:00Z", now), "včera");
  assert.equal(formatRelative("2026-08-25T12:00:00Z", now), "před 3 týdny");
});

test("formatRelative: nad 30 dní má relativní údaj nulovou vypovídací hodnotu", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const stare = formatRelative("2026-05-01T12:00:00Z", now);
  assert.match(stare, /1\. 5\. 2026/);
  assert.ok(!stare.startsWith("před"));
});

test("spendRatio: strop 0 nic neblokuje a nikdy nevrátí NaN", () => {
  assert.equal(spendRatio(5, 0), 0);
  assert.equal(spendRatio(5, -1), 0);
  assert.equal(spendRatio(5, Number.NaN), 0);
  assert.equal(spendRatio(Number.NaN, 10), 0);
  assert.equal(spendRatio(0.3, 0.6), 0.5);
  assert.equal(spendRatio(10, 0.6), 1);
});
