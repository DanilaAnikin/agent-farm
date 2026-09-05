/**
 * Konzumace fronty q_media: přečti zprávu → zpracuj job → ack.
 * Chyby:
 *  - BudgetExceededError → projekt 'budget_hold', zpráva se NEackuje
 *    (crash-safe redelivery po vt = requeue bez ztráty; po resetu okna projde),
 *  - ostatní chyba → event; do MAX_DELIVERIES necháme zprávu na retry,
 *    pak ji zahodíme (ack) a asset označíme 'failed'.
 */
import { BudgetExceededError } from "@farm/core";
import {
  ackDelete,
  enqueue,
  events,
  getDb,
  projects,
  QUEUES,
  readOne,
  type QueueMessage,
  isFarmPaused,
} from "@farm/db";
import { and, eq } from "drizzle-orm";
import { failJobAsset, handleMediaJob } from "./jobs.js";
import type { MediaJob } from "./types.js";

const POLL_IDLE_MS = 2000;
const MAX_DELIVERIES = 5;

/**
 * Nastaví projekt do budget_hold — JEN z 'active' (status guard). Bez guardu se u už
 * drženého projektu re-stampoval updated_at každý tick; kvůli $onUpdate (heldSince =
 * updated_at) by se okno auto-resume posouvalo donekonečna a projekt by se nikdy
 * neobnovil (porušení invariantu „farma se nikdy trvale nezastaví").
 */
async function setProjectBudgetHold(projectId: string): Promise<void> {
  await getDb()
    .update(projects)
    .set({ status: "budget_hold" })
    .where(and(eq(projects.id, projectId), eq(projects.status, "active")));
}

async function logError(projectId: string, message: string, data?: Record<string, unknown>): Promise<void> {
  await getDb()
    .insert(events)
    .values({ projectId, level: "error", type: "media_error", message, data: data ?? null });
}

/** Zpracuje jednu zprávu. Vrací true, když se něco udělalo (jinak fronta prázdná). */
async function processOne(): Promise<boolean> {
  const msg = (await readOne<MediaJob>(QUEUES.media)) as QueueMessage<MediaJob> | null;
  if (!msg) return false;

  const job = msg.message;
  try {
    await handleMediaJob(job);
    await ackDelete(QUEUES.media, msg.msgId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Rozpočet vyčerpán — pozdrž projekt, zprávu nech na redelivery (bez ztráty).
      await setProjectBudgetHold(job.projectId);
      await logError(job.projectId, `Media budget_hold (scope=${err.scope}) — čeká se na reset okna.`, {
        scope: err.scope,
        job: job.job,
      });
      // NEackujeme: po vypršení visibility timeoutu se zpráva vrátí do fronty.
      return true;
    }

    // Ostatní chyba: retry do MAX_DELIVERIES. POZOR: nepoužíváme pgmq read_ct
    // jako čítač selhání — ten se zvyšuje i při budget-hold odkladech (redelivery),
    // takže by job po dni čekání spadl na první reálné chybě. Držíme vlastní
    // failCount v payloadu a re-enqueujeme čerstvou kopii (ackneme původní).
    const failCount = (job.failCount ?? 0) + 1;
    if (failCount >= MAX_DELIVERIES) {
      await failJobAsset(job).catch(() => {});
      await ackDelete(QUEUES.media, msg.msgId);
      await logError(job.projectId, `Media job ${job.job} selhal definitivně (${failCount}×): ${String(err)}`, {
        job: job.job,
      });
    } else {
      await enqueue(QUEUES.media, { ...job, failCount });
      await ackDelete(QUEUES.media, msg.msgId);
      await logError(job.projectId, `Media job ${job.job} selhal (pokus ${failCount}), retry: ${String(err)}`, {
        job: job.job,
      });
    }
  }
  return true;
}

/** Hlavní smyčka. Běží, dokud `signal` neřekne stop. */
export async function runMediaLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    let did = false;
    try {
      // Zastavená farma = zastavená i výroba médií. Ptá se PŘED vyzvednutím
      // zprávy z fronty, ne uprostřed jobu: odmítnutí uprostřed by se tvářilo
      // jako selhání assetu a job by se po pěti pokusech nenávratně zahodil.
      if (await isFarmPaused()) {
        await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
        continue;
      }
      did = await processOne();
    } catch (err) {
      // Neočekávaná chyba infrastruktury (např. DB výpadek) — chvíli počkej.
      console.error("[media-pipeline] chyba smyčky:", err);
    }
    if (!did) {
      await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
    }
  }
}
