import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDuplicate,
  isLoopingOutput,
  normalize,
  similarity,
  taskDedupKey,
} from "./dedup.js";

test("normalize odstraní diakritiku, interpunkci a sjednotí velikost písmen", () => {
  assert.equal(normalize("Ěščř ŽÁÁ!"), "escr zaa");
  assert.equal(normalize("Hello, World!!!"), "hello world");
  assert.equal(normalize("  multiple   spaces  "), "multiple spaces");
  assert.equal(normalize("Příliš žluťoučký kůň"), "prilis zlutoucky kun");
  // interpunkce se změní na mezeru (oddělovač), ne na nic
  assert.equal(normalize("a.b-c"), "a b c");
});

test("similarity je 1 pro shodné řetězce", () => {
  assert.equal(similarity("hello world", "hello world"), 1);
  // normalizace: liší se jen velikostí/interpunkcí → stále 1
  assert.equal(similarity("Hello, World", "hello world"), 1);
});

test("similarity je 0 pro disjunktní řetězce", () => {
  assert.equal(similarity("abc", "xyz"), 0);
});

test("similarity je symetrická", () => {
  const a = "refactor the auth module";
  const b = "refactor the authentication service";
  assert.equal(similarity(a, b), similarity(b, a));
});

test("similarity: dva prázdné → 1, jeden prázdný → 0", () => {
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("nonempty", ""), 0);
  assert.equal(similarity("", "nonempty"), 0);
});

test("similarity: podobné řetězce leží mezi 0 a 1", () => {
  const s = similarity("add login button", "add logout button");
  assert.ok(s > 0 && s < 1, `očekáváno (0,1), dostáno ${s}`);
});

test("taskDedupKey je stabilní a normalizovaný", () => {
  const k1 = taskDedupKey("Add Login", "User can sign in!");
  const k2 = taskDedupKey("Add Login", "User can sign in!");
  assert.equal(k1, k2);
  assert.equal(k1, normalize("Add Login User can sign in!"));
  assert.equal(k1, "add login user can sign in");
});

test("isDuplicate respektuje práh (near-dup nad, unrelated pod)", () => {
  const existing = ["add login button to header", "fix payment webhook"];
  // téměř shodné → nad prahem
  assert.equal(isDuplicate("add login button to header", existing, 0.9), true);
  // nesouvisející → pod prahem
  assert.equal(isDuplicate("write documentation for api", existing, 0.9), false);
  // vysoký práh 1.0 vyžaduje přesnou shodu
  assert.equal(isDuplicate("add login button to heade", existing, 1), false);
  assert.equal(isDuplicate("add login button to header", existing, 1), true);
});

test("isLoopingOutput detekuje zopakovaný výstup", () => {
  const previous = ["output A varianta jedna", "jiný completely different result"];
  assert.equal(isLoopingOutput("output A varianta jedna", previous, 0.9), true);
  assert.equal(isLoopingOutput("brand new unique unrelated text", previous, 0.9), false);
});

test("isLoopingOutput: prázdná historie → false", () => {
  assert.equal(isLoopingOutput("cokoliv", [], 0.9), false);
});
