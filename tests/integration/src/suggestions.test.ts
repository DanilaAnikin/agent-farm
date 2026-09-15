/**
 * Test 8 — převod návrhu na přání přes JEDINOU sdílenou implementaci
 * (@farm/db convertSuggestionToWish), kterou volá orchestrátor i Telegram.
 * Asertuje konzistenci (návrh ukazuje na existující přání, důvod, událost) a
 * pravidla, která nesmí obejít ani ruční klik: pozastavený projekt, návrh bez
 * projektu, cizí uživatel, dvojí převod.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { convertSuggestionToWish, events, getDb, getSql, suggestions, wishes } from "@farm/db";
import { createUser, createProject, createSuggestion, teardown } from "./helpers.js";

after(teardown);

test("suggestion.new → converted vytvoří přání, důvod a událost suggestion_converted", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const suggestionId = await createSuggestion(userId, {
    projectId,
    kind: "feature",
    title: "Přidej --json flag",
    description: "Strojově čitelný výstup.",
    rationale: "Doklad z repozitáře: src/cli.ts",
    status: "new",
  });

  const db = getDb();
  const res = await convertSuggestionToWish(db, suggestionId, { source: "autopilot" });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const after = (await db.select().from(suggestions).where(eq(suggestions.id, suggestionId)))[0]!;
  assert.equal(after.status, "converted", "návrh je converted");
  assert.equal(after.wishId, res.wishId, "návrh ukazuje na nové přání");
  assert.equal(after.decidedReason, "converted");
  assert.ok(after.decidedAt instanceof Date, "decidedAt je vyplněno");

  const wish = (await db.select().from(wishes).where(eq(wishes.id, res.wishId)))[0]!;
  assert.equal(wish.source, "autopilot");
  assert.equal(wish.status, "new");
  assert.match(wish.description, /Proč: Doklad z repozitáře/);

  const ev = await db.select().from(events).where(eq(events.wishId, res.wishId));
  assert.equal(ev.filter((e) => e.type === "suggestion_converted").length, 1);

  // Referenční integrita join dotazem: návrh ↔ přání sedí.
  const sql = getSql();
  const joined = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM suggestions s JOIN wishes w ON w.id = s.wish_id
    WHERE s.id = ${suggestionId}`;
  assert.equal(joined[0]!.n, 1, "join suggestion→wish vrátí právě 1 řádek");

  // Druhý převod téhož návrhu nesmí založit druhé přání.
  const again = await convertSuggestionToWish(db, suggestionId, { source: "telegram" });
  assert.deepEqual(again, { ok: false, reason: "already_decided" });
  const count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wishes WHERE project_id = ${projectId}`;
  assert.equal(count[0]!.n, 1);
});

test("do pozastaveného projektu, bez projektu ani cizímu uživateli se nepřevádí", async () => {
  const userId = await createUser();
  const stranger = await createUser();
  const pausedProject = await createProject(userId, { status: "paused" });
  const activeProject = await createProject(userId);
  const db = getDb();

  const paused = await createSuggestion(userId, { projectId: pausedProject, title: "Do pauzy", status: "new" });
  assert.deepEqual(await convertSuggestionToWish(db, paused, { source: "autopilot" }), {
    ok: false,
    reason: "project_paused",
  });

  const orphan = await createSuggestion(userId, { projectId: null, title: "Napříč projekty", status: "new" });
  assert.deepEqual(await convertSuggestionToWish(db, orphan, { source: "telegram", userId }), {
    ok: false,
    reason: "no_project",
  });

  const foreign = await createSuggestion(userId, { projectId: activeProject, title: "Cizí", status: "new" });
  assert.deepEqual(await convertSuggestionToWish(db, foreign, { source: "telegram", userId: stranger }), {
    ok: false,
    reason: "not_found",
  });

  const sql = getSql();
  const n = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wishes WHERE project_id IN (${pausedProject}, ${activeProject})`;
  assert.equal(n[0]!.n, 0, "žádné přání nevzniklo");
  const still = (await db.select().from(suggestions).where(eq(suggestions.id, paused)))[0]!;
  assert.equal(still.status, "new", "odmítnutý převod návrh nemění");
});
