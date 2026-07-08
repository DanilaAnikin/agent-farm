/**
 * Konzument fronty q_deploy — PREVIEW deploye (bez approvalu, na farm Dokploy).
 * Orchestrátor sem zařadí zprávu poté, co dokončí code přání a pushne main.
 * Produkční deploye jdou naopak přes approval bránu (deploy-loop.ts), NE tudy.
 */
import { getDb, projects, readOne, ackDelete } from "@farm/db";
import { eq } from "drizzle-orm";
import { deployPreview } from "./dokploy.js";
import { logEvent } from "./events.js";
import type { DeployJob } from "./types.js";

const DEPLOY_VT_SEC = Number(process.env.DEPLOY_VISIBILITY_SEC ?? 300);
const IDLE_SLEEP_MS = Number(process.env.DEPLOY_QUEUE_IDLE_SLEEP_MS ?? 5000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function previewDomain(projectId: string): string | undefined {
  const base = process.env.PREVIEW_BASE_DOMAIN;
  return base ? `preview-${projectId.slice(0, 8)}.${base}` : undefined;
}

/** Zpracuje jednu zprávu z q_deploy. Vrací true, pokud něco zpracoval. */
export async function pollDeployQueueOnce(): Promise<boolean> {
  const msg = await readOne<DeployJob>("q_deploy", DEPLOY_VT_SEC);
  if (!msg) return false;

  const job = msg.message;
  try {
    const rows = await getDb().select().from(projects).where(eq(projects.id, job.projectId)).limit(1);
    const project = rows[0];
    if (!project) {
      // Projekt neexistuje → zprávu zahoď.
      await ackDelete("q_deploy", msg.msgId);
      return true;
    }
    if (project.repoMode === "none" || !project.repoUrl) {
      // Není co nasadit (projekt bez repa) — tiše zahoď.
      await ackDelete("q_deploy", msg.msgId);
      return true;
    }

    await deployPreview(project, {
      repoUrl: project.repoUrl,
      branch: "main",
      domain: previewDomain(project.id),
    });
    await ackDelete("q_deploy", msg.msgId);
  } catch (err) {
    console.error(`[publisher] preview deploy projektu ${job.projectId} selhal:`, err);
    await logEvent({
      projectId: job.projectId,
      wishId: job.wishId ?? null,
      level: "error",
      type: "deploy.preview.failed",
      message: `Preview deploy selhal: ${String(err)}`,
    });
    // Zpráva se po vypršení visibility timeoutu objeví znovu (retry).
  }
  return true;
}

/** Nekonečná smyčka preview deployů; končí, když `isRunning()` vrátí false. */
export async function runDeployQueueLoop(isRunning: () => boolean): Promise<void> {
  while (isRunning()) {
    let worked = false;
    try {
      worked = await pollDeployQueueOnce();
    } catch (err) {
      console.error("[publisher] deploy queue loop error:", err);
    }
    if (!worked) await sleep(IDLE_SLEEP_MS);
  }
}
