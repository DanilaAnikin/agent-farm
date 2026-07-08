// Perennial — Telegram bot: druhý velín + proaktivní reportovací kanál.
// grammY long polling (žádné příchozí porty).
import { Bot } from "grammy";
import { closeDb } from "@farm/db";
import type { BotContext } from "./types.js";
import { requireEnv } from "./types.js";
import { registerPairing } from "./pairing.js";
import { registerCommands } from "./commands.js";
import { registerViews } from "./views.js";
import { registerSwarm } from "./swarm.js";
import { registerControl } from "./control.js";
import { registerSuggestions } from "./suggestions.js";
import { registerWishes, clearPendingWishes } from "./wishes.js";
import { registerApprovals, startApprovalsPoller } from "./approvals.js";
import { startDigestScheduler } from "./alerts.js";
import { startReporter } from "./reporter.js";

async function main(): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const bot = new Bot<BotContext>(token);

  // Pořadí je důležité: /start + auth middleware (v pairing) jako první,
  // aby všechny další handlery měly ctx.user. Command handlery před
  // message:text (wishes), aby /use, /wish, … měly přednost.
  registerPairing(bot);
  registerCommands(bot);
  registerViews(bot);
  registerSwarm(bot);
  registerControl(bot);
  // Před registerWishes: /suggestions je command a musí mít přednost před
  // message:text catch-allem, který ostatní text zpracuje jako přání.
  registerSuggestions(bot);
  registerWishes(bot);
  registerApprovals(bot);

  // Zveřejni seznam příkazů v UI Telegramu.
  await bot.api
    .setMyCommands([
      { command: "start", description: "Spárovat účet / nápověda" },
      { command: "help", description: "Nápověda — všechny příkazy" },
      { command: "status", description: "Přehled farmy" },
      { command: "projects", description: "Seznam projektů s progresem" },
      { command: "project", description: "Detail projektu: /project <projekt>" },
      { command: "agents", description: "Kdo právě pracuje" },
      { command: "swarm", description: "Velín roje — živý snímek paralelismu" },
      { command: "suggestions", description: "Návrhy farmy — co dál" },
      { command: "digest", description: "Shrnutí posledních 24 h" },
      { command: "use", description: "Nastav aktivní projekt: /use <projekt>" },
      { command: "wish", description: "Založ přání: /wish <projekt> <text>" },
      { command: "say", description: "Napiš projektu: /say <projekt> <text>" },
      { command: "note", description: "Poznámka manažerovi: /note <projekt> <text>" },
      { command: "pause", description: "Pozastavit projekt: /pause <projekt>" },
      { command: "resume", description: "Obnovit projekt: /resume <projekt>" },
      { command: "budget", description: "Denní strop: /budget <projekt> <usd>" },
      { command: "kill", description: "ADMIN: globální pauza + abort" },
    ])
    .catch(() => {
      /* setMyCommands je best-effort */
    });

  // Chybová izolace — jeden špatný update nesmí shodit bota.
  bot.catch((err) => {
    console.error("[telegram-bot] chyba při zpracování update:", err.error);
  });

  // Pollery na pozadí.
  const intervals: NodeJS.Timeout[] = [
    startApprovalsPoller(bot),
    startReporter(bot),
    startDigestScheduler(bot),
  ];

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[telegram-bot] ${signal} — vypínám…`);
    for (const i of intervals) clearInterval(i);
    clearPendingWishes();
    await bot.stop();
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[telegram-bot] startuji long polling…");
  await bot.start({
    onStart: (info) => console.log(`[telegram-bot] běžím jako @${info.username}`),
  });
}

main().catch((err) => {
  console.error("[telegram-bot] fatální chyba:", err);
  process.exit(1);
});
