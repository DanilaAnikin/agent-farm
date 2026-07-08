/**
 * Publisher — jediný proces s publikačními a produkčně-deploy tokeny (OVERVIEW §5.6).
 * Startuje dvě smyčky:
 *   1) publish loop  — konzumuje q_publish (Instagram publikace po approvalu),
 *   2) deploy loop   — produkční deploye po approvalu deploy_prod.
 * Graceful shutdown na SIGINT/SIGTERM.
 */
import { closeDb } from "@farm/db";
import { runPublishLoop } from "./publish-loop.js";
import { runDeployLoop } from "./deploy-loop.js";
import { runDeployQueueLoop } from "./deploy-queue.js";

// Re-export veřejného API pro integrátora (preview deploy volá orchestrátor).
export { deployPreview, deployProduction } from "./dokploy.js";
export { requireApproved, ApprovalError } from "./approvals.js";

function assertEnv(): void {
  const required = ["DATABASE_URL", "LITELLM_MASTER_KEY", "CREDENTIALS_ENCRYPTION_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Publisher nelze spustit — chybí povinné proměnné prostředí: ${missing.join(", ")}. Doplň je do .env.`,
    );
  }
}

async function main(): Promise<void> {
  assertEnv();

  let running = true;
  const isRunning = () => running;

  const shutdown = (signal: string) => {
    if (!running) return;
    console.log(`[publisher] ${signal} — ukončuji (dokončuji rozdělanou práci)…`);
    running = false;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[publisher] startuji publish + deploy smyčky…");

  const loops = [
    runPublishLoop(isRunning),
    runDeployLoop(isRunning),
    runDeployQueueLoop(isRunning),
  ];
  await Promise.allSettled(loops);

  await closeDb().catch(() => {
    /* best-effort */
  });
  console.log("[publisher] zastaveno.");
}

main().catch((err) => {
  console.error("[publisher] fatální chyba:", err);
  process.exitCode = 1;
});
