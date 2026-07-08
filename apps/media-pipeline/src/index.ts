/**
 * Vstupní bod media pipeline — dlouhoběžící Node služba konzumující q_media.
 * Spustí smyčku a zajistí graceful shutdown (dokončí rozdělanou zprávu, pak
 * zavře DB spojení).
 */
import { closeDb, ensureQueues } from "@farm/db";
import { runMediaLoop } from "./media-loop.js";

async function main(): Promise<void> {
  // Fronty by měl založit bootstrap; voláme idempotentně pro jistotu.
  await ensureQueues().catch((err) => {
    console.error("[media-pipeline] ensureQueues selhalo (pokračuji):", err);
  });

  const signal = { stopped: false };

  const shutdown = (sig: string) => {
    console.log(`[media-pipeline] ${sig} — ukončuji po dokončení aktuální zprávy…`);
    signal.stopped = true;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[media-pipeline] spuštěno, konzumuji q_media.");
  await runMediaLoop(signal);

  await closeDb();
  console.log("[media-pipeline] ukončeno.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[media-pipeline] fatální chyba:", err);
  process.exit(1);
});
