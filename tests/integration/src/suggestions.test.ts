/**
 * Test 8 — suggestions convert flow (DB-level).
 * Vlož návrh → simuluj převod (vlož wish + nastav status='converted' + wishId) →
 * asertuj konzistenci (návrh ukazuje na existující wish).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, getSql, suggestions, wishes } from "@farm/db";
import { createUser, createProject, createSuggestion, teardown } from "./helpers.js";

after(teardown);

test("suggestion.new → converted vytvoří wish a naváže wishId", async () => {
  const userId = await createUser();
  const projectId = await createProject(userId);
  const suggestionId = await createSuggestion(userId, {
    projectId,
    kind: "feature",
    title: "Přidej --json flag",
    description: "Strojově čitelný výstup.",
    status: "new",
  });

  const db = getDb();

  // Před převodem: status new, bez wishId.
  const before = (await db.select().from(suggestions).where(eq(suggestions.id, suggestionId)))[0]!;
  assert.equal(before.status, "new");
  assert.equal(before.wishId, null);

  // Převod: vytvoř wish z návrhu a označ návrh jako converted.
  const wishId = (
    await db
      .insert(wishes)
      .values({ projectId, title: before.title, description: before.description ?? "" })
      .returning({ id: wishes.id })
  )[0]!.id;

  await db
    .update(suggestions)
    .set({ status: "converted", wishId, decidedAt: new Date() })
    .where(eq(suggestions.id, suggestionId));

  // Po převodu: konzistence.
  const after = (await db.select().from(suggestions).where(eq(suggestions.id, suggestionId)))[0]!;
  assert.equal(after.status, "converted", "návrh je converted");
  assert.equal(after.wishId, wishId, "návrh ukazuje na nový wish");
  assert.ok(after.decidedAt instanceof Date, "decidedAt je vyplněno");

  const wishExists = (
    await db.select({ id: wishes.id }).from(wishes).where(eq(wishes.id, wishId))
  )[0];
  assert.ok(wishExists, "navázaný wish reálně existuje");

  // Referenční integrita join dotazem: návrh ↔ wish sedí.
  const sql = getSql();
  const joined = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM suggestions s JOIN wishes w ON w.id = s.wish_id
    WHERE s.id = ${suggestionId}`;
  assert.equal(joined[0]!.n, 1, "join suggestion→wish vrátí právě 1 řádek");
});
