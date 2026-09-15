import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMinorSlices } from "./chart-slices";
import { busiestProjectCap } from "./admin-guards";
import { DLOUHY_TEXT_ZNAKU, isLongText, splitVisible } from "./show-more";

test("graf modelů: drobný model jde z grafu do poznámky, nulový zmizí", () => {
  // 14 dní produkce: V4 Pro 1,81 US$, V4 Flash 0,036 US$, aliasy s nulou.
  const r = splitMinorSlices([
    { name: "DeepSeek V4 Pro", value: 1.809 },
    { name: "DeepSeek V4 Flash", value: 0.0358 },
    { name: "Worker", value: 0.001 },
    { name: "Cheap", value: 0 },
  ]);
  assert.deepEqual(r.major.map((m) => m.name), ["DeepSeek V4 Pro"]);
  assert.deepEqual(r.minor.map((m) => m.name), ["DeepSeek V4 Flash"]);
  assert.ok(Math.abs(r.total - 1.8458) < 1e-9);
});

test("graf modelů: vyrovnané položky zůstanou v grafu", () => {
  const r = splitMinorSlices([
    { name: "A", value: 1 },
    { name: "B", value: 0.5 },
  ]);
  assert.equal(r.major.length, 2);
  assert.equal(r.minor.length, 0);
  assert.deepEqual(splitMinorSlices([]), { major: [], minor: [], total: 0 });
});

test("nejbližší strop projektů: pozastavený projekt se stropem 0 nevyhraje", () => {
  const projekty = [
    { id: "loot", name: "loot", status: "paused", daily_cap_usd: 0 },
    { id: "explain", name: "explain-and-act", status: "paused", daily_cap_usd: 0 },
    { id: "contentgen", name: "contentgen", status: "active", daily_cap_usd: 0.3 },
    { id: "ripieno", name: "ripieno", status: "budget_hold", daily_cap_usd: 0.3 },
    { id: "ivanweb", name: "ivanweb", status: "budget_hold", daily_cap_usd: 0.3 },
    { id: "stary", name: "starý", status: "stopped", daily_cap_usd: 0.1 },
  ];
  const utrata = new Map([
    ["ripieno", 0.1978],
    ["ivanweb", 0.1813],
    ["stary", 0.5],
  ]);
  assert.deepEqual(busiestProjectCap(projekty, utrata), { name: "ripieno", spent: 0.1978, cap: 0.3 });
  // Jen neaktivní projekty nebo nulové stropy → žádná vrstva, ne „0,00 z 0,00 US$".
  assert.equal(busiestProjectCap(projekty.slice(0, 2), utrata), null);
  assert.equal(busiestProjectCap([{ id: "x", name: "x", status: "active", daily_cap_usd: 0 }], utrata), null);
});

test("dlouhé seznamy: prvních N a zbytek; jedna schovaná položka se neschovává", () => {
  const polozky = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(splitVisible(polozky, 5), { visible: [1, 2, 3, 4, 5], rest: [6, 7] });
  assert.deepEqual(splitVisible(polozky.slice(0, 6), 5), { visible: [1, 2, 3, 4, 5, 6], rest: [] });
  assert.deepEqual(splitVisible([], 3), { visible: [], rest: [] });
});

test("dlouhý text záznamu mozku se sbalí podle znaků i řádků", () => {
  assert.equal(isLongText("krátké"), false);
  assert.equal(isLongText("x".repeat(DLOUHY_TEXT_ZNAKU + 1)), true);
  assert.equal(isLongText("a\nb\nc\nd\ne\nf"), true);
  assert.equal(isLongText(null), false);
});
