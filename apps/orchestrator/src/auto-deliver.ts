/**
 * Auto-doručení (univerzální princip, zatím zapojena content-publish cesta):
 * u projektů s autonomy.autoDeliver se hotový reel sám pošle k publikaci —
 * do denního capu se approval SCHVÁLÍ automaticky, nad cap čeká na jeden tap.
 *
 * BEZPEČNOST: produkční deploy (deploy_prod) zůstává VŽDY na lidském schválení,
 * bez ohledu na autoDeliver — nevratná akce s vysokým rizikem.
 */
import {
  getDb,
  getSql,
  projects,
  profiles,
  mediaAssets,
  publishRequests,
  approvals,
  QUEUES,
  enqueue,
} from "@farm/db";
import type { ProjectAutonomy } from "@farm/db";
import { and, eq } from "drizzle-orm";
import { getPlan, effectivePlanKey } from "@farm/billing";
import { logEvent } from "./events.js";
import { isGlobalPaused } from "./settings.js";

const DEFAULT_DELIVER_CAP = 1;

type Project = typeof projects.$inferSelect;

function autonomy(p: Project): ProjectAutonomy {
  return (p.autonomy ?? {}) as ProjectAutonomy;
}

/** Kolik postů projektu dnes už odešlo/čeká (počítá se do denního capu). */
async function deliveredToday(projectId: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM publish_requests pr
    JOIN media_assets m ON m.id = pr.media_asset_id
    WHERE m.project_id = ${projectId}
      AND pr.created_at >= date_trunc('day', now() at time zone 'UTC')
      AND pr.status <> 'failed'
  `;
  return rows[0]?.n ?? 0;
}

export async function runAutoDeliverOnce(): Promise<void> {
  if (await isGlobalPaused()) return;

  const active = await getDb().select().from(projects).where(eq(projects.status, "active"));
  for (const p of active) {
    const a = autonomy(p);
    if (!a.autoDeliver) continue;

    // Feature-gate: Instagram publikace je jen v plánech s instagram=true (Pro+). Bez
    // téhle brány by auto-deliver publikoval i pro Free/Starter, které IG v ceně nemají
    // (plan.instagram se jinak nikde nevynucuje). Efektivní plán ⇒ respektuje i dunning.
    const planRows = await getDb()
      .select({ planKey: profiles.planKey, subStatus: profiles.subscriptionStatus })
      .from(profiles)
      .where(eq(profiles.userId, p.userId))
      .limit(1);
    if (!getPlan(effectivePlanKey(planRows[0]?.planKey, planRows[0]?.subStatus)).instagram) continue;

    const cap = a.deliverDailyCap && a.deliverDailyCap > 0 ? a.deliverDailyCap : DEFAULT_DELIVER_CAP;

    // Hotové reely bez publish_requestu.
    const reels = await getSql()<{ id: string; meta: Record<string, unknown> | null }[]>`
      SELECT m.id, m.meta FROM media_assets m
      WHERE m.project_id = ${p.id} AND m.kind = 'reel' AND m.status = 'generated'
        AND NOT EXISTS (SELECT 1 FROM publish_requests pr WHERE pr.media_asset_id = m.id)
      ORDER BY m.created_at ASC LIMIT 3
    `;
    if (reels.length === 0) continue;

    for (const reel of reels) {
      const caption =
        (reel.meta && typeof reel.meta.caption === "string" ? (reel.meta.caption as string) : null) ??
        null;
      const underCap = (await deliveredToday(p.id)) < cap;

      // Založ publish_request.
      const prRow = await getDb()
        .insert(publishRequests)
        .values({
          mediaAssetId: reel.id,
          target: "instagram",
          caption,
          status: underCap ? "approved" : "pending_approval",
        })
        .returning({ id: publishRequests.id });
      const prId = prRow[0]?.id;
      if (!prId) continue;

      // Approval — buď rovnou schválený (do capu), nebo čekající (jeden tap).
      const apRow = await getDb()
        .insert(approvals)
        .values({
          userId: p.userId,
          projectId: p.id,
          type: "publish",
          payload: { publishRequestId: prId, mediaAssetId: reel.id, caption, auto: true },
          status: underCap ? "approved" : "pending",
          requestedBy: "auto-deliver",
          decidedVia: underCap ? "dashboard" : undefined,
          decidedAt: underCap ? new Date() : undefined,
        })
        .returning({ id: approvals.id });
      const approvalId = apRow[0]?.id;

      await getDb()
        .update(publishRequests)
        .set({ approvalId: approvalId ?? null })
        .where(eq(publishRequests.id, prId));

      if (underCap) {
        await enqueue(QUEUES.publish, { publishRequestId: prId });
        await logEvent({
          projectId: p.id,
          type: "auto_deliver",
          message: "Auto-doručení: reel automaticky schválen a odeslán k publikaci.",
          data: { publishRequestId: prId, mediaAssetId: reel.id },
        });
      } else {
        await logEvent({
          projectId: p.id,
          level: "warn",
          type: "auto_deliver_pending",
          message: "Denní limit doručení vyčerpán — reel čeká na tvé schválení.",
          data: { publishRequestId: prId, mediaAssetId: reel.id },
        });
      }
    }
  }
}
