/**
 * Orchestrátor — srdce farmy (OVERVIEW §5.2).
 * Jeden dlouho běžící Node proces s kooperujícími smyčkami. Top-level supervisor
 * restartuje spadlou smyčku; SIGTERM/SIGINT spustí graceful shutdown.
 */
import { loadConfig } from "@farm/core";
import { ensureQueues, closeDb } from "@farm/db";
import { runLoop, requestStop, isStopping, sleep } from "./loop.js";
import { logEvent } from "./events.js";
import { runManagerOnce } from "./manager.js";
import { runRefillOnce } from "./refill.js";
import { runDispatchOnce } from "./dispatch.js";
import { runJudgeOnce } from "./judge.js";
import { runQaLoop } from "./tester.js";
import { runReconciliationOnce } from "./reconciliation.js";
import { runBudgetHoldOnce } from "./budget-hold.js";
import { runSttOnce } from "./stt.js";
import { runLitellmSyncOnce } from "./litellm-sync.js";
import { runSuggestionsOnce, runSelfRunOnce } from "./suggestions.js";
import { runSupervisorOnce } from "./supervisor.js";
import { runAutoDeliverOnce } from "./auto-deliver.js";

interface LoopSpec {
  name: string;
  everyMs: number;
  fn: () => Promise<void>;
}

// SWARM: počet SOUBĚŽNÝCH dispatch slotů = kolik workerů běží najednou.
// Každá dispatch smyčka čte z q_tasks přes FOR UPDATE SKIP LOCKED, takže N smyček
// = N paralelních workerů bez race (jiná zpráva pro každou). Serializuje se jen
// merge (rebase-onto-main v mergeToMain). Řízeno MAX_WORKERS_TOTAL.
const WORKER_SLOTS = Math.max(1, loadConfig().maxWorkersTotal);

const LOOPS: LoopSpec[] = [
  { name: "manager", everyMs: 5_000, fn: runManagerOnce },
  { name: "refill", everyMs: 30_000, fn: runRefillOnce },
  // N paralelních dispatch slotů (swarm).
  ...Array.from({ length: WORKER_SLOTS }, (_, i) => ({
    name: `dispatch-${i + 1}`,
    everyMs: 2_000,
    fn: runDispatchOnce,
  })),
  // Víc judge slotů — judge (build/test v kontejneru) je taky paralelizovatelný.
  ...Array.from({ length: Math.max(2, Math.ceil(WORKER_SLOTS / 2)) }, (_, i) => ({
    name: `judge-${i + 1}`,
    everyMs: 3_000,
    fn: runJudgeOnce,
  })),
  { name: "tester", everyMs: 4_000, fn: runQaLoop },
  { name: "reconciliation", everyMs: 5 * 60_000, fn: runReconciliationOnce },
  { name: "budget-hold", everyMs: 60_000, fn: runBudgetHoldOnce },
  { name: "stt", everyMs: 5_000, fn: runSttOnce },
  { name: "litellm-sync", everyMs: 30_000, fn: runLitellmSyncOnce },
  // Univerzální autonomie (kadence si každá smyčka hlídá sama).
  { name: "suggestions", everyMs: 5 * 60_000, fn: runSuggestionsOnce },
  { name: "self-run", everyMs: 60_000, fn: runSelfRunOnce },
  { name: "supervisor", everyMs: 30 * 60_000, fn: runSupervisorOnce },
  { name: "auto-deliver", everyMs: 45_000, fn: runAutoDeliverOnce },
];

/** Supervisor: drží smyčku běžící; když spadne (runLoop by neměl, ale pro jistotu), restartuje. */
async function supervise(spec: LoopSpec): Promise<void> {
  while (!isStopping()) {
    try {
      await runLoop(spec.name, spec.everyMs, spec.fn);
      return; // korektní ukončení (stopping)
    } catch (err) {
      console.error(`[supervisor:${spec.name}] smyčka spadla, restart za 5 s:`, err);
      await sleep(5_000);
    }
  }
}

async function main(): Promise<void> {
  // Ověř základní konfiguraci hned na startu (jasné chyby, ne až za běhu).
  loadConfig();
  console.log("[orchestrator] start.");

  try {
    await ensureQueues();
  } catch (err) {
    console.error("[orchestrator] ensureQueues selhalo (pokračuji):", err);
  }

  await logEvent({ type: "orchestrator_start", message: "Orchestrátor nastartoval." });

  // Reconciliation hned při startu (úklid po případném pádu).
  try {
    await runReconciliationOnce();
  } catch (err) {
    console.error("[orchestrator] startovní reconciliation selhalo:", err);
  }

  installSignalHandlers();

  // Spusť všechny smyčky paralelně; čekej na jejich (graceful) doběhnutí.
  await Promise.all(LOOPS.map((spec) => supervise(spec)));

  await shutdown();
}

function installSignalHandlers(): void {
  const onSignal = (sig: string) => {
    console.log(`[orchestrator] ${sig} — zahajuji graceful shutdown…`);
    requestStop();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

async function shutdown(): Promise<void> {
  console.log("[orchestrator] smyčky zastaveny, uklízím…");
  await logEvent({ type: "orchestrator_stop", message: "Orchestrátor se vypíná." }).catch(
    () => undefined,
  );
  // Zavři sdílené DB spojení.
  await closeDb().catch(() => undefined);
  console.log("[orchestrator] hotovo.");
}

main().catch((err) => {
  console.error("[orchestrator] fatální chyba:", err);
  process.exitCode = 1;
});
