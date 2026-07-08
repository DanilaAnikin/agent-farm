/**
 * Dokploy deploy — dvě úrovně:
 *  (a) deployPreview  — na FARM Dokploy (farm VPS), BEZ approvalu (jen preview).
 *  (b) deployProduction — na produkční Dokploy UŽIVATELE, JEN po requireApproved,
 *      s health checkem a automatickým rollbackem při selhání.
 *
 * Všechna volání jdou přes fetch (Dokploy REST/OpenAPI, header x-api-key).
 * POZOR: přesné cesty Dokploy API se mezi verzemi liší — viz uncertainties
 * v manifestu; endpointy jsou centralizované zde, aby se snadno doladily.
 */
import { getCredentials } from "./connections.js";
import { requireApproved } from "./approvals.js";
import { logEvent } from "./events.js";
import type { DeployArtifact, DokployCredentials } from "./types.js";
import type { projects } from "@farm/db";

type ProjectRow = typeof projects.$inferSelect;

const HEALTH_TIMEOUT_MS = Number(process.env.DEPLOY_HEALTH_TIMEOUT_MS ?? 120_000);
const HEALTH_INTERVAL_MS = Number(process.env.DEPLOY_HEALTH_INTERVAL_MS ?? 5000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- nízkoúrovňový Dokploy klient -------------------------------------------
async function dokployRequest(
  base: string,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${base.replace(/\/$/, "")}/api/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Dokploy ${method} ${path} selhalo (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

/** Vytvoří (nebo dohledá) aplikaci a spustí deploy. Vrací applicationId. */
async function createOrDeployApp(
  base: string,
  apiKey: string,
  appName: string,
  artifact: DeployArtifact,
): Promise<string> {
  let appId = artifact.appId;

  if (!appId) {
    const created = await dokployRequest(base, apiKey, "POST", "application.create", {
      name: appName,
      appName,
      dockerImage: artifact.image,
      repository: artifact.repoUrl,
      branch: artifact.branch,
      env: artifact.env,
    });
    appId = String(created.applicationId ?? created.id ?? "");
    if (!appId) throw new Error("Dokploy nevrátil applicationId po vytvoření aplikace.");
  }

  await dokployRequest(base, apiKey, "POST", "application.deploy", { applicationId: appId });
  return appId;
}

/** Health check: čeká, dokud doména nevrací 2xx, nebo do timeoutu. */
async function healthCheck(domain: string): Promise<boolean> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual" });
      if (res.status >= 200 && res.status < 400) return true;
    } catch {
      // ještě nenaběhlo — zkoušíme dál
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

// --- (a) Preview na farm Dokploy --------------------------------------------
/**
 * Preview deploy na FARM Dokploy (bez approvalu — běží na farm boxu, nikdy na produkci).
 * Vrací applicationId a preview URL (pokud je známá doména).
 */
export async function deployPreview(
  project: ProjectRow,
  artifact: DeployArtifact,
): Promise<{ appId: string; url?: string }> {
  const base = process.env.FARM_DOKPLOY_URL;
  const apiKey = process.env.FARM_DOKPLOY_API_KEY;
  if (!base || !apiKey) {
    throw new Error("FARM_DOKPLOY_URL / FARM_DOKPLOY_API_KEY nejsou nastavené — preview deploy nelze provést.");
  }

  const appName = `preview-${project.id.slice(0, 8)}`;
  const appId = await createOrDeployApp(base, apiKey, appName, artifact);

  await logEvent({
    projectId: project.id,
    type: "deploy.preview.triggered",
    message: `Preview deploy spuštěn pro projekt ${project.name}.`,
    data: { appId },
  });

  return { appId, url: artifact.domain };
}

// --- (b) Produkce na Dokploy uživatele (jen po approvalu) --------------------
/**
 * Produkční deploy — vyžaduje approved `deploy_prod`. Health check + auto-rollback.
 * Credentials produkčního Dokploy čte z per-user connection (kind='dokploy').
 */
export async function deployProduction(input: {
  project: ProjectRow;
  approvalId: string;
  artifact: DeployArtifact;
}): Promise<{ appId: string; ok: boolean }> {
  const { project, approvalId, artifact } = input;

  // Bezpečnostní brána: bez approved řádku se nedeployuje.
  await requireApproved(approvalId);

  const { creds } = await getCredentials<DokployCredentials>(project.userId, "dokploy");
  if (!creds.url || !creds.apiKey) {
    throw new Error(`Produkční Dokploy connection uživatele ${project.userId} nemá url/apiKey.`);
  }

  const appName = `prod-${project.id.slice(0, 8)}`;

  // Zachyť aktuální (poslední úspěšný) deployment kvůli rollbacku.
  let previousDeploymentId: string | undefined;
  try {
    const info = await dokployRequest(creds.url, creds.apiKey, "GET", `application.one?applicationId=${artifact.appId ?? ""}`);
    previousDeploymentId = typeof info.deploymentId === "string" ? info.deploymentId : undefined;
  } catch {
    // první deploy — není kam rollbacknout
  }

  const appId = await createOrDeployApp(creds.url, creds.apiKey, appName, artifact);

  const domain = artifact.domain;
  const healthy = domain ? await healthCheck(domain) : true;

  if (!healthy) {
    await logEvent({
      projectId: project.id,
      level: "error",
      type: "deploy.prod.health_failed",
      message: `Produkční deploy neprošel health checkem (${domain}). Spouštím rollback.`,
      data: { appId, approvalId },
    });
    // Auto-rollback: vrať předchozí deployment, pokud existuje.
    try {
      await dokployRequest(creds.url, creds.apiKey, "POST", "application.rollback", {
        applicationId: appId,
        deploymentId: previousDeploymentId,
      });
      await logEvent({
        projectId: project.id,
        level: "warn",
        type: "deploy.prod.rolled_back",
        message: "Produkční deploy rollbacknut na předchozí verzi.",
        data: { appId, previousDeploymentId },
      });
    } catch (err) {
      await logEvent({
        projectId: project.id,
        level: "error",
        type: "deploy.prod.rollback_failed",
        message: `Rollback selhal: ${err instanceof Error ? err.message : String(err)}`,
        data: { appId },
      });
    }
    return { appId, ok: false };
  }

  await logEvent({
    projectId: project.id,
    type: "deploy.prod.succeeded",
    message: `Produkční deploy projektu ${project.name} proběhl a je zdravý.`,
    data: { appId, approvalId },
  });
  return { appId, ok: true };
}
