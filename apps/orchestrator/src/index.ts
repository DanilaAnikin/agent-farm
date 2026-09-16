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
import { runSpendSyncOnce } from "./spend-sync.js";
import { runSuggestionsOnce, runSelfRunOnce } from "./suggestions.js";
import { runSupervisorOnce } from "./supervisor.js";
import { runProjectDiscoveryOnce } from "./project-discovery.js";
import { runAutoDeliverOnce } from "./auto-deliver.js";
import { runDeliveryOnce } from "./delivery.js";

import { Agent, setGlobalDispatcher } from "undici";
import { shouldFarmRun } from "./settings.js";
import { judgeSlots, workerSlots } from "./runtime-config.js";

// Node global fetch (undici) má defaultní headersTimeout i bodyTimeout 300 s.
// Volání modelu delší než pět minut proto umřelo na "TypeError: fetch failed" —
// a při DeepSeeku s desítkami tisíc tokenů v kontextu je pět minut běžně málo.
// Tohle byla příčina 202 z 204 selhání za uplynulý týden: selhání se počítalo
// jako infra, po deseti se úkol zaparkoval a všechno, co na něm viselo, se
// zablokovalo (207 čekajících úkolů, 0 spustitelných).
//
// opencode.ts si vlastní dispatcher nastavil už dřív, ale kanál k modelům
// (manager, judge, refill, architekt) v packages/llm zůstal na výchozím fetchi.
// Nastavuje se proto GLOBÁLNĚ pro celý proces — ať to platí i pro volání, která
// vzniknou později a na vlastní dispatcher se zapomene.
// Skutečný strop drží AbortSignal volajícího, wall-clock guard a request_timeout
// v LiteLLM, ne tenhle limit.
setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 60_000 }),
);


interface LoopSpec {
  name: string;
  everyMs: number;
  fn: () => Promise<void>;
}

// SWARM: počet SOUBĚŽNÝCH dispatch slotů = kolik workerů běží najednou.
// Každá dispatch smyčka čte z q_tasks přes FOR UPDATE SKIP LOCKED, takže N smyček
// = N paralelních workerů bez race (jiná zpráva pro každou). Serializuje se jen
// merge (rebase-onto-main v mergeToMain). Řízeno MAX_WORKERS_TOTAL.
// Výpočet je v runtime-config.ts — stejná čísla zapisuje do farm_settings pro dashboard.
const WORKER_SLOTS = workerSlots();

/**
 * Obalí smyčku globálním vypínačem.
 *
 * `global_pause` byl dosud jen ADMISSION gate uvnitř dispatche: zabránil vpuštění
 * dalšího tasku do fronty, ale smyčky, které volají placené modely mimo dispatch
 * (manager, refill, suggestions, self-run, supervisor, auto-deliver), běžely dál
 * a utrácely i s vypnutou farmou. Telegram bot přitom uživateli tvrdil, že /kill
 * zastaví všechno.
 *
 * Kontroluje se na začátku KAŽDÉ iterace, ne jednou při startu — pauza se zapíná
 * za běhu a musí zabrat bez restartu orchestrátoru.
 *
 * Od `shouldFarmRun` se ptáme i na vyčerpaný měsíční strop. Dřív ho hlídal jen
 * dispatch, takže dvanáct dalších míst volajících placený model (manager, judge,
 * refill, suggestions, supervisor, tester, memory) utrácelo bez jakékoli brány.
 * Rozhodnout se MUSÍ tady, před zahájením práce — výjimka vyhozená uprostřed
 * placeného volání se u volajících tváří jako selhání úkolu a zahodila by hotovou
 * práci, za kterou už se zaplatilo.
 */
const pausable = (fn: () => Promise<void>): (() => Promise<void>) => {
  return async () => {
    if (!(await shouldFarmRun())) return;
    await fn();
  };
};

const LOOPS: LoopSpec[] = [
  { name: "manager", everyMs: 5_000, fn: pausable(runManagerOnce) },
  { name: "refill", everyMs: 30_000, fn: pausable(runRefillOnce) },
  // N paralelních dispatch slotů (swarm).
  ...Array.from({ length: WORKER_SLOTS }, (_, i) => ({
    name: `dispatch-${i + 1}`,
    everyMs: 2_000,
    fn: pausable(runDispatchOnce),
  })),
  // Víc judge slotů — judge (build/test v kontejneru) je taky paralelizovatelný.
  ...Array.from({ length: judgeSlots() }, (_, i) => ({
    name: `judge-${i + 1}`,
    everyMs: 3_000,
    fn: pausable(runJudgeOnce),
  })),
  { name: "tester", everyMs: 4_000, fn: pausable(runQaLoop) },
  { name: "reconciliation", everyMs: 5 * 60_000, fn: runReconciliationOnce },
  { name: "budget-hold", everyMs: 60_000, fn: runBudgetHoldOnce },
  { name: "stt", everyMs: 5_000, fn: pausable(runSttOnce) },
  { name: "litellm-sync", everyMs: 30_000, fn: runLitellmSyncOnce },
  // Most reálného LiteLLM spendu → cost_ledger (US$ v dashboardu + vynucení stropu).
  { name: "spend-sync", everyMs: 60_000, fn: runSpendSyncOnce },
  // Univerzální autonomie (kadence si každá smyčka hlídá sama).
  { name: "suggestions", everyMs: 5 * 60_000, fn: pausable(runSuggestionsOnce) },
  { name: "self-run", everyMs: 60_000, fn: pausable(runSelfRunOnce) },
  { name: "supervisor", everyMs: 30 * 60_000, fn: pausable(runSupervisorOnce) },
  // Průzkum repozitáře: farma si sama zjistí (a v sandboxu ověří), jak projekt
  // spustit. Vlastní smyčka schválně — dispatch nesmí čekat, až sonda doběhne.
  { name: "project-discovery", everyMs: 10 * 60_000, fn: pausable(runProjectDiscoveryOnce) },
  { name: "auto-deliver", everyMs: 45_000, fn: pausable(runAutoDeliverOnce) },
  // Merge smyčka ZÁMĚRNĚ bez `pausable`: sloučení PR nestojí žádné tokeny a
  // autonomní farma nemá čekat na konec off-peaku ani na reset rozpočtu. Vypínač
  // majitele (`owner_pause`) si smyčka čte jako první věc uvnitř sama.
  { name: "delivery", everyMs: 60_000, fn: runDeliveryOnce },
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
