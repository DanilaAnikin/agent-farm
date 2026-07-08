/**
 * Deploy handling — produkční deploye. Publisher je jediný, kdo drží produkční
 * Dokploy tokeny, takže produkční deploy řídí on. Trigger: approved approval
 * typu `deploy_prod`. Komunikace jen přes DB (žádná sdílená HTTP mezi appkami).
 *
 * Preview deploye (bez approvalu) spouští orchestrátor voláním deployPreview()
 * z tohoto balíčku — nemají vlastní frontu (viz integration notes).
 */
import { getDb, approvals, projects, events } from "@farm/db";
import { and, eq, sql } from "drizzle-orm";
import { deployProduction } from "./dokploy.js";
import { logEvent } from "./events.js";
import type { DeployProdPayload } from "./types.js";

const DEPLOY_POLL_INTERVAL_MS = Number(process.env.DEPLOY_POLL_INTERVAL_MS ?? 15_000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Už jsme tento approval zpracovali? (deterministický marker v events) */
async function alreadyHandled(approvalId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, "deploy.prod.handled"),
        sql`${events.data} ->> 'approvalId' = ${approvalId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Zapíše 'handled' marker PŘÍMO (ne přes logEvent, který chyby polyká) a vrátí,
 *  zda se zápis povedl. Prod deploy je destruktivní → „at most once": marker píšeme
 *  PŘED deployem jako claim; když se nezapíše, radši nedeployujeme (spíš nic než 2×). */
async function markHandled(approvalId: string, projectId: string | null): Promise<boolean> {
  try {
    await getDb().insert(events).values({
      projectId,
      type: "deploy.prod.handled",
      message: "Deploy_prod approval převzat ke zpracování.",
      data: { approvalId },
    });
    return true;
  } catch (err) {
    console.error("[publisher] zápis deploy.prod.handled markeru selhal:", err);
    return false;
  }
}

/** Poslední známý Dokploy appId projektu (kvůli redeployi stejné app + rollbacku). */
async function lastKnownAppId(projectId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ data: events.data })
    .from(events)
    .where(and(eq(events.type, "deploy.prod.app"), eq(events.projectId, projectId)))
    .orderBy(sql`${events.ts} DESC`)
    .limit(1);
  const appId = (rows[0]?.data as { appId?: string } | null)?.appId;
  return appId && appId.length > 0 ? appId : undefined;
}

/** Zpracuje jeden schválený deploy_prod approval. */
async function handleApproval(approvalId: string, projectId: string | null, payload: DeployProdPayload): Promise<void> {
  if (await alreadyHandled(approvalId)) return;

  const targetProjectId = payload.projectId ?? projectId;
  if (!targetProjectId) {
    await logEvent({
      level: "error",
      type: "deploy.prod.bad_payload",
      message: `Approval ${approvalId} (deploy_prod) nemá projectId — přeskočeno.`,
      data: { approvalId },
    });
    // Označit jako zpracované, ať to nezacyklí.
    await logEvent({ type: "deploy.prod.handled", data: { approvalId } });
    return;
  }

  const projRows = await getDb().select().from(projects).where(eq(projects.id, targetProjectId)).limit(1);
  const project = projRows[0];
  if (!project) {
    await logEvent({
      level: "error",
      type: "deploy.prod.project_missing",
      message: `Projekt ${targetProjectId} pro deploy_prod approval ${approvalId} neexistuje.`,
      data: { approvalId },
    });
    await logEvent({ type: "deploy.prod.handled", data: { approvalId } });
    return;
  }

  // CLAIM marker PŘED destruktivním prod deployem (jinak crash uprostřed deploye
  // = při dalším pollu DUPLICITNÍ produkční deploy). Když se claim nezapíše, radši
  // nedeployuj. Žádný auto-retry bez člověka (to je záměr).
  if (!(await markHandled(approvalId, project.id))) return;

  // Reuse existující Dokploy app (jinak každý deploy zakládá NOVOU app a rollback
  // je no-op kvůli prázdnému appId). Poslední známý appId injektujeme do artefaktu.
  const artifact = { ...(payload.artifact ?? {}) };
  if (!artifact.appId) {
    const known = await lastKnownAppId(targetProjectId);
    if (known) artifact.appId = known;
  }

  try {
    const res = await deployProduction({ project, approvalId, artifact });
    // Zapamatuj appId pro příští redeploy/rollback, kdykoliv se liší od toho, co
    // jsme použili (i když přišel v payloadu) — jinak by příští deploy bez appId
    // v payloadu založil novou app a rollback by byl no-op.
    if (res.appId && res.appId !== artifact.appId) {
      await logEvent({
        projectId: project.id,
        type: "deploy.prod.app",
        message: "Zapamatován Dokploy appId projektu pro budoucí redeploy.",
        data: { appId: res.appId },
      });
    }
  } catch (err) {
    await logEvent({
      projectId: project.id,
      level: "error",
      type: "deploy.prod.error",
      message: `Produkční deploy selhal: ${err instanceof Error ? err.message : String(err)}`,
      data: { approvalId },
    });
  }
}

/** Jeden průchod: najdi schválené deploy_prod approvaly a zpracuj je. */
export async function pollDeployOnce(): Promise<void> {
  const rows = await getDb()
    .select()
    .from(approvals)
    .where(and(eq(approvals.type, "deploy_prod"), eq(approvals.status, "approved")));

  for (const a of rows) {
    await handleApproval(a.id, a.projectId, (a.payload ?? {}) as unknown as DeployProdPayload);
  }
}

/** Smyčka produkčních deployů; končí, když `isRunning()` vrátí false. */
export async function runDeployLoop(isRunning: () => boolean): Promise<void> {
  while (isRunning()) {
    try {
      await pollDeployOnce();
    } catch (err) {
      console.error("[publisher] deploy loop error:", err);
    }
    await sleep(DEPLOY_POLL_INTERVAL_MS);
  }
}
