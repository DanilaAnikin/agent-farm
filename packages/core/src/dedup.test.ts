import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORK_DEDUP_THRESHOLD,
  classifyWorkScore,
  isDuplicate,
  isLoopingOutput,
  normalize,
  normalizeWork,
  rankSimilarWork,
  similarity,
  taskDedupKey,
  workSimilarity,
} from "./dedup.js";

test("normalizeWork: česká diakritika, interpunkce a velikost písmen nerozhodují", () => {
  assert.equal(
    normalizeWork("Přidat přihlášení", "Formulář na /login, e-mail + heslo."),
    "pridat prihlaseni formular na login e mail heslo",
  );
  assert.equal(normalizeWork("ŽLUŤOUČKÝ kůň", null), "zlutoucky kun");
  assert.equal(normalizeWork("", ""), "");
});

test("normalizeWork: z dlouhého popisu bere jen začátek", () => {
  const long = "a".repeat(5000);
  assert.ok(normalizeWork("Titulek", long).length < 700);
});

test("workSimilarity: stejná práce s jinou diakritikou a interpunkcí je nad prahem 0,55", () => {
  const a = { title: "Přidat přihlášení přes e-mail", description: "Formulář /login s e-mailem a heslem." };
  const b = { title: "pridat prihlaseni pres email", description: "formular login s emailem a heslem" };
  assert.ok(workSimilarity(a, b) >= WORK_DEDUP_THRESHOLD, `skóre ${workSimilarity(a, b)}`);
});

test("workSimilarity: nesouvisející česká zadání jsou pod prahem", () => {
  const a = { title: "Přidat tmavý režim", description: "Přepínač tmavého režimu v hlavičce." };
  const b = { title: "Opravit webhook Stripe", description: "Ošetřit chybu podpisu webhooku." };
  assert.ok(workSimilarity(a, b) < WORK_DEDUP_THRESHOLD);
  assert.equal(classifyWorkScore(workSimilarity(a, b)), "unknown");
});

test("workSimilarity: krátký titulek bez popisu proti dlouhému popisu nepadne na nulu", () => {
  const short = { title: "Přidat Sentry monitoring", description: "" };
  const long = {
    title: "Monitoring chyb přes Sentry",
    description:
      "Napojit Sentry na backend i frontend, aby se chyby hlásily. " +
      "Nastavit DSN přes proměnnou prostředí, zachytávat nezachycené výjimky a odmítnuté sliby. ".repeat(4),
  };
  const s = workSimilarity(short, long);
  // Délka popisu nesmí skóre stáhnout pod nejisté pásmo — o shodě pak rozhodne model.
  assert.ok(s >= 0.3, `skóre ${s}`);
  assert.equal(workSimilarity(short, long), workSimilarity(long, short));
});

test("workSimilarity: prázdný vstup není shoda s ničím", () => {
  assert.equal(workSimilarity({ title: "", description: "" }, { title: "", description: "" }), 0);
  assert.equal(workSimilarity({ title: "", description: null }, { title: "Přidat testy" }), 0);
  assert.equal(workSimilarity({ title: "!!!" }, { title: "Přidat testy" }), 0);
});

test("classifyWorkScore: jisté pásmo nad 0,8 a pod 0,3, jinak rozhoduje model", () => {
  assert.equal(classifyWorkScore(0.81), "known");
  assert.equal(classifyWorkScore(0.8), "uncertain");
  assert.equal(classifyWorkScore(0.55), "uncertain");
  assert.equal(classifyWorkScore(0.3), "uncertain");
  assert.equal(classifyWorkScore(0.29), "unknown");
});

test("rankSimilarWork: nejbližší první, limit a vyřazení nulových shod", () => {
  const corpus = [
    { title: "Opravit webhook Stripe", description: "podpis" },
    { title: "Přidat přihlášení e-mailem", description: "formulář /login" },
    { title: "Přihlášení přes e-mail", description: "login formulář s heslem" },
    { title: "", description: "" },
  ];
  const ranked = rankSimilarWork({ title: "Přihlášení e-mailem", description: "formulář /login" }, corpus, 2);
  assert.equal(ranked.length, 2);
  assert.ok(ranked[0]!.score >= ranked[1]!.score);
  assert.match(ranked[0]!.item.title, /přihlášení/i);
  assert.equal(rankSimilarWork({ title: "" }, corpus).length, 0);
  assert.equal(rankSimilarWork({ title: "x" }, [], 5).length, 0);
});

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
