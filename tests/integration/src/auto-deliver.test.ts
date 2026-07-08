/**
 * Test 9 — auto-deliver cap counting.
 * media_assets(kind='reel', status='generated') + publish_requests pro projekt.
 * "Delivered today" = počet dnes publikovaných publish_requests projektu; cap
 * logika (autonomy.deliverDailyCap) povolí doručení jen dokud delivered < cap.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getDb, getSql, mediaAssets, publishRequests } from "@farm/db";
import { createUser, createProject, teardown } from "./helpers.js";

after(teardown);

const DELIVER_CAP = 3;

/** Kolik reelů projektu bylo doručeno (publikováno) DNES. */
async function deliveredToday(projectId: string): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM publish_requests pr
    JOIN media_assets m ON m.id = pr.media_asset_id
    WHERE m.project_id = ${projectId}
      AND pr.status = 'published'
      AND pr.published_at >= date_trunc('day', now())`;
  return rows[0]!.n;
}

async function addReel(projectId: string): Promise<string> {
  const rows = await getDb()
    .insert(mediaAssets)
    .values({ projectId, kind: "reel", status: "generated" })
    .returning({ id: mediaAssets.id });
  return rows[0]!.id;
}

async function publish(mediaAssetId: string, when: Date): Promise<void> {
  await getDb()
    .insert(publishRequests)
    .values({ mediaAssetId, target: "instagram", status: "published", publishedAt: when });
}

test("deliveredToday počítá jen dnešní publikace a řídí cap gate", async () => {
  const userId = await createUser({ planKey: "pro" });
  const projectId = await createProject(userId, {
    autonomy: { autoDeliver: true, deliverDailyCap: DELIVER_CAP },
  });

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Dva reely publikované dnes + jeden včera (nesmí se počítat).
  await publish(await addReel(projectId), now);
  await publish(await addReel(projectId), now);
  await publish(await addReel(projectId), yesterday);
  // Jeden vygenerovaný, ale nepublikovaný reel (taky se nepočítá).
  await addReel(projectId);

  let delivered = await deliveredToday(projectId);
  assert.equal(delivered, 2, "dnes doručené = 2 (včerejší a nepublikovaný se nepočítají)");

  // Cap gate: 2 < 3 → smíme doručit další.
  assert.equal(delivered < DELIVER_CAP, true, "pod capem → auto-deliver povolen");

  // Doruč třetí dnes → dosáhneme capu.
  await publish(await addReel(projectId), now);
  delivered = await deliveredToday(projectId);
  assert.equal(delivered, 3, "po třetí publikaci = 3");
  assert.equal(delivered < DELIVER_CAP, false, "na capu → další auto-deliver zablokován");
});
