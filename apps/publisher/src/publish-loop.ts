/**
 * Konzument fronty q_publish. Každá zpráva odkazuje na publish_request.
 * Instagram publikace projde JEN s approved approvalem; jinak zůstane čekat.
 * manual = pouze download (nikdy sem nedorazí); youtube zatím nepodporováno.
 */
import {
  getDb,
  publishRequests,
  mediaAssets,
  projects,
  profiles,
  readOne,
  ackDelete,
  extendVt,
  isFarmPaused,
} from "@farm/db";
import type { PreferenceProfile } from "@farm/db";
import { createStorage } from "@farm/storage";
import { and, eq, gte } from "drizzle-orm";
import { requireApproved, ApprovalError } from "./approvals.js";
import { logEvent } from "./events.js";
import { generateCaption } from "./caption.js";
import {
  getFreshInstagramCredentials,
  assertPublishingLimit,
  publishReel,
  publishImage,
  type PublishResult,
} from "./instagram.js";
import type { PublishJob } from "./types.js";

const PUBLISH_VT_SEC = Number(process.env.PUBLISH_VISIBILITY_SEC ?? 120);
const PUBLISH_WORK_VT_SEC = Number(process.env.PUBLISH_WORK_VT_SEC ?? 600);
const MAX_POSTS_PER_DAY = Number(process.env.IG_MAX_POSTS_PER_DAY ?? 3);
const IDLE_SLEEP_MS = Number(process.env.PUBLISH_IDLE_SLEEP_MS ?? 5000);

type PublishRequestRow = typeof publishRequests.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Kolik IG postů uživatel dnes (UTC) publikoval — self-imposed limit. */
async function countPublishedToday(userId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ id: publishRequests.id })
    .from(publishRequests)
    .innerJoin(mediaAssets, eq(publishRequests.mediaAssetId, mediaAssets.id))
    .innerJoin(projects, eq(mediaAssets.projectId, projects.id))
    .where(
      and(
        eq(projects.userId, userId),
        eq(publishRequests.target, "instagram"),
        eq(publishRequests.status, "published"),
        gte(publishRequests.publishedAt, start),
      ),
    );
  return rows.length;
}

async function loadUserProfile(userId: string): Promise<PreferenceProfile | undefined> {
  const rows = await getDb()
    .select({ pref: profiles.preferenceProfile })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return rows[0]?.pref;
}

async function markFailed(pr: PublishRequestRow, reason: string): Promise<void> {
  await getDb()
    .update(publishRequests)
    .set({ status: "failed" })
    .where(eq(publishRequests.id, pr.id));
  await logEvent({
    level: "error",
    type: "publish.failed",
    message: reason,
    data: { publishRequestId: pr.id, target: pr.target },
  });
}

/**
 * Zpracuje jednu publish_request. Vrací "ack" (odstranit z fronty) nebo
 * "keep" (nechat, ať se po vt znovu objeví — čeká na approval / transient).
 */
async function processRequest(pr: PublishRequestRow, msgId: string): Promise<"ack" | "keep"> {
  // Idempotence: už publikováno → jen uklidit frontu.
  if (pr.status === "published") return "ack";

  // Ochrana proti DUPLICITNÍ publikaci: pokud už máme externalId, nebo request
  // zůstal v 'publishing' (předchozí běh spadl po vytvoření IG postu), NEpublikuj
  // znovu — jinak by na Instagramu vznikl druhý post. Radši uklidit + upozornit.
  if (pr.externalId) {
    // Prokazatelně publikováno → jen dokonči finalizaci (kdyby minule spadl poslední
    // zápis stavu) a acknuj. Idempotentní, žádný duplikát.
    await getDb()
      .update(publishRequests)
      .set({ status: "published", publishedAt: pr.publishedAt ?? new Date() })
      .where(eq(publishRequests.id, pr.id));
    await getDb().update(mediaAssets).set({ status: "published" }).where(eq(mediaAssets.id, pr.mediaAssetId));
    await logEvent({
      level: "info",
      type: "publish.already_published",
      message: "publish_request už má externalId — dokončena finalizace (bez re-publikace).",
      data: { publishRequestId: pr.id, externalId: pr.externalId },
    });
    return "ack";
  }
  if (pr.status === "publishing") {
    // Uvázlé v 'publishing' bez externalId = předchozí worker patrně spadl UPROSTŘED
    // publikace (VT je dlouhý, takže to není souběžný redeliver). Nevíme jistě, jestli
    // post na IG vznikl → NEpublikuj znovu naslepo, nahlas k ruční kontrole.
    await markFailed(
      pr,
      "Publikace uvázla v 'publishing' (worker spadl uprostřed). Ověř na Instagramu, jestli post vznikl; " +
        "pokud NE, publikuj znovu z Knihovny. (Neopakujeme automaticky, ať nevznikne duplikát.)",
    );
    return "ack";
  }

  if (pr.target === "manual") {
    // manual = jen download, sem nemá co přijít.
    await logEvent({
      level: "warn",
      type: "publish.manual_skipped",
      message: "publish_request s target=manual se do fronty nemá dostávat — přeskočeno.",
      data: { publishRequestId: pr.id },
    });
    return "ack";
  }

  if (pr.target === "youtube") {
    await markFailed(pr, "YouTube publikace zatím není podporována (jen Content Library / ruční upload).");
    return "ack";
  }

  // --- Instagram ---
  // Bezpečnostní brána: bez approved approvalu se nepublikuje.
  try {
    await requireApproved(pr.approvalId);
  } catch (err) {
    if (err instanceof ApprovalError && err.pending) {
      // Čeká na rozhodnutí — necháme zprávu ve frontě (redeliver po vt).
      if (pr.status !== "pending_approval") {
        await getDb()
          .update(publishRequests)
          .set({ status: "pending_approval" })
          .where(eq(publishRequests.id, pr.id));
      }
      return "keep";
    }
    // Terminální (chybí/zamítnuto/expirováno) — nepublikovat.
    await markFailed(pr, err instanceof Error ? err.message : String(err));
    return "ack";
  }

  // Načti media asset + projekt (kvůli userId).
  const assetRows = await getDb()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, pr.mediaAssetId))
    .limit(1);
  const asset: MediaAssetRow | undefined = assetRows[0];
  if (!asset || !asset.storagePath) {
    await markFailed(pr, `Media asset ${pr.mediaAssetId} chybí nebo nemá storage_path.`);
    return "ack";
  }

  const projRows = await getDb()
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, asset.projectId))
    .limit(1);
  const proj = projRows[0];
  if (!proj) {
    await markFailed(pr, `Projekt ${asset.projectId} pro media asset neexistuje.`);
    return "ack";
  }

  // Self-imposed denní limit + Graph API content_publishing_limit.
  const todayCount = await countPublishedToday(proj.userId);
  if (todayCount >= MAX_POSTS_PER_DAY) {
    await markFailed(
      pr,
      `Denní limit publikací dosažen (${todayCount}/${MAX_POSTS_PER_DAY}). Zkus to zítra.`,
    );
    return "ack";
  }

  const creds = await getFreshInstagramCredentials(proj.userId);
  await assertPublishingLimit(creds);

  // Caption: použij zadaný, jinak vygeneruj přes levný model.
  let caption = pr.caption ?? "";
  if (!caption.trim()) {
    const profile = await loadUserProfile(proj.userId);
    caption = await generateCaption({
      context: `Media kind: ${asset.kind}. Meta: ${JSON.stringify(asset.meta)}`,
      profile,
      userId: proj.userId,
      projectId: proj.id,
    });
  }

  // Veřejná URL média (Graph API stahuje médium z této URL).
  const storage = createStorage();
  const mediaUrl = await storage.getSignedUrl(asset.storagePath, 3600);

  // Přepni na publishing a prodluž viditelnost (IG polling může trvat minuty).
  await getDb()
    .update(publishRequests)
    .set({ status: "publishing" })
    .where(eq(publishRequests.id, pr.id));
  await extendVt("q_publish", msgId, PUBLISH_WORK_VT_SEC).catch(() => {
    /* best-effort */
  });

  let result: PublishResult;
  try {
    if (asset.kind === "reel" || asset.kind === "video_clip") {
      result = await publishReel(creds, mediaUrl, caption);
    } else {
      result = await publishImage(creds, mediaUrl, caption);
    }
  } catch (err) {
    await markFailed(pr, `Instagram publikace selhala: ${err instanceof Error ? err.message : String(err)}`);
    return "ack";
  }

  // Úspěch: zapiš externí id, permalink, čas; asset → published. RETRY, protože
  // post na IG UŽ EXISTUJE — kdyby tenhle zápis selhal, ztratili bychom externalId
  // a request by uvázl v 'publishing' (recovery výše ho pak nahlásí k ruční kontrole).
  const now = new Date();
  let wrote = false;
  for (let i = 0; i < 4 && !wrote; i++) {
    try {
      await getDb()
        .update(publishRequests)
        .set({
          status: "published",
          externalId: result.externalId,
          permalink: result.permalink ?? null,
          publishedAt: now,
        })
        .where(eq(publishRequests.id, pr.id));
      wrote = true;
    } catch (err) {
      console.error(`[publisher] zápis externalId selhal (pokus ${i + 1}/4):`, err);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  // Když se externalId ani po retry nezapsal, zprávu NEACKUJEME (return "keep") —
  // request zůstává 'publishing' a při redeliveru ho recovery na začátku nahlásí
  // k ruční kontrole. Ackovat by znamenalo tichý strand + ztracený externalId.
  if (!wrote) {
    await logEvent({
      projectId: proj.id,
      level: "error",
      type: "publish.persist_failed",
      message: `Post na IG vznikl (${result.externalId}), ale zápis do DB opakovaně selhal — nechávám ve frontě k recovery.`,
      data: { publishRequestId: pr.id, externalId: result.externalId },
    });
    return "keep";
  }

  await getDb()
    .update(mediaAssets)
    .set({ status: "published" })
    .where(eq(mediaAssets.id, asset.id))
    .catch((e) => console.error("[publisher] media_asset published update selhal:", e));

  await logEvent({
    projectId: proj.id,
    type: "publish.published",
    message: `Publikováno na Instagram (${result.externalId}).`,
    data: { publishRequestId: pr.id, externalId: result.externalId, permalink: result.permalink },
  });
  return "ack";
}

/** Přečte a zpracuje jednu zprávu z q_publish. Vrací true, pokud něco zpracoval. */
export async function pollPublishOnce(): Promise<boolean> {
  const msg = await readOne<PublishJob>("q_publish", PUBLISH_VT_SEC);
  if (!msg) return false;

  const publishRequestId = msg.message?.publishRequestId;
  if (!publishRequestId) {
    await logEvent({
      level: "error",
      type: "publish.bad_message",
      message: "Zpráva q_publish nemá publishRequestId — zahazuji.",
      data: { msgId: msg.msgId },
    });
    await ackDelete("q_publish", msg.msgId);
    return true;
  }

  const prRows = await getDb()
    .select()
    .from(publishRequests)
    .where(eq(publishRequests.id, publishRequestId))
    .limit(1);
  const pr = prRows[0];
  if (!pr) {
    await logEvent({
      level: "warn",
      type: "publish.request_missing",
      message: `publish_request ${publishRequestId} neexistuje — zahazuji zprávu.`,
      data: { msgId: msg.msgId },
    });
    await ackDelete("q_publish", msg.msgId);
    return true;
  }

  let decision: "ack" | "keep";
  try {
    decision = await processRequest(pr, msg.msgId);
  } catch (err) {
    // Neočekávaná chyba (síť/DB) — nech zprávu, ať se po vt zkusí znovu.
    await logEvent({
      level: "error",
      type: "publish.error",
      message: `Chyba při zpracování publish_request ${pr.id}: ${err instanceof Error ? err.message : String(err)}`,
      data: { publishRequestId: pr.id },
    });
    decision = "keep";
  }

  if (decision === "ack") {
    await ackDelete("q_publish", msg.msgId);
  }
  return true;
}

/** Nekonečná smyčka publikace; končí, když `isRunning()` vrátí false. */
export async function runPublishLoop(isRunning: () => boolean): Promise<void> {
  while (isRunning()) {
    let worked = false;
    try {
      // Zastavená farma = i publikace počká. Caption jde přes placený model
      // a hlavně: `/kill` má znamenat „nic se neděje", ne „orchestrátor stojí,
      // zbytek jede". Zpráva zůstane ve frontě, po odpauzování se zpracuje.
      if (await isFarmPaused()) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }
      worked = await pollPublishOnce();
    } catch (err) {
      console.error("[publisher] publish loop error:", err);
    }
    if (!worked) await sleep(IDLE_SLEEP_MS);
  }
}
