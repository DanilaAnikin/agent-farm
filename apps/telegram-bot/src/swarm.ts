// /swarm (/roj) — živý velín roje: kompaktní snímek paralelismu napříč projekty
// uživatele. Kolik agentů teď žije, kdo právě pracuje (role + model + projekt +
// úkol), throughput za hodinu, náklady a hloubka fronty. Read-only, HTML escape.
import { Bot } from "grammy";
import type { BotContext } from "./types.js";
import { formatUsd } from "./types.js";
import { b, escapeHtml, humanizeDuration } from "./format.js";
import {
  getUserLastHourSpend,
  getUserProjects,
  getUserQueueDepth,
  getUserRunningAgents,
  getUserThroughputLastHour,
  getUserTodaySpend,
} from "./db-helpers.js";
import type { RunningAgentRow } from "./db-helpers.js";

// Agent s heartbeatem novějším než tohle je "živý" (stejné jako ve views.ts).
const AGENT_FRESH_MS = Number(process.env.TELEGRAM_AGENT_FRESH_MS ?? 120000);
const agentCutoff = (): Date => new Date(Date.now() - AGENT_FRESH_MS);

// Kolik řádků „kdo pracuje" maximálně vypíšeme.
const MAX_WORKER_LINES = 10;

const ROLE_LABEL: Record<string, string> = {
  manager: "🧠 manažer",
  worker: "🛠️ worker",
  judge: "⚖️ judge",
  media: "🎬 media",
  publisher: "📤 publisher",
};

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

function agentDuration(a: RunningAgentRow): string {
  const from = a.startedAt ?? a.lastHeartbeat;
  return humanizeDuration(Date.now() - from.getTime());
}

export function registerSwarm(bot: Bot<BotContext>): void {
  const handler = async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) return;

    const projectsRows = await getUserProjects(user.userId);
    if (projectsRows.length === 0) {
      await ctx.reply("Zatím nemáš žádné projekty. Založ si první v dashboardu.");
      return;
    }

    const [running, throughput, todaySpend, hourSpend, queueDepth] = await Promise.all([
      getUserRunningAgents(user.userId, agentCutoff()),
      getUserThroughputLastHour(user.userId),
      getUserTodaySpend(user.userId),
      getUserLastHourSpend(user.userId),
      getUserQueueDepth(user.userId),
    ]);

    // Paralelismus = počet živých agentů, co právě pracují (busy).
    const busy = running.filter((r) => r.status === "busy");

    const lines: string[] = [
      b("🐝 Velín roje"),
      "",
      `⚡ Paralelismus: ${b(String(busy.length))} · živých agentů: ${running.length}`,
      `🏁 Throughput: ${throughput} ${czAttempts(throughput)}/h`,
      `📥 Fronta: ${queueDepth} ${czTasksQueued(queueDepth)}`,
      `💵 Poslední hodina: ${escapeHtml(formatUsd(hourSpend))} · dnes: ${escapeHtml(formatUsd(todaySpend))}`,
    ];

    lines.push("", b("Kdo právě pracuje:"));
    if (running.length === 0) {
      lines.push("💤 Právě nikdo — roj čeká na práci nebo je pozastavený.");
    } else {
      for (const a of running.slice(0, MAX_WORKER_LINES)) {
        const proj = a.projectName ? escapeHtml(a.projectName) : "?";
        const model = a.model ? ` ${escapeHtml(a.model)}` : "";
        const task = a.taskTitle
          ? ` — „${escapeHtml(a.taskTitle)}“`
          : a.status === "busy"
            ? ""
            : " (čeká)";
        lines.push(`• ${roleLabel(a.role)}${model} · ${b(proj)}${task} · ⏱ ${agentDuration(a)}`);
      }
      if (running.length > MAX_WORKER_LINES) {
        lines.push(`…a další ${running.length - MAX_WORKER_LINES}`);
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  };

  bot.command("swarm", (ctx) => handler(ctx));
  bot.command("roj", (ctx) => handler(ctx));
}

function czAttempts(n: number): string {
  if (n === 1) return "pokus";
  if (n >= 2 && n <= 4) return "pokusy";
  return "pokusů";
}

function czTasksQueued(n: number): string {
  if (n === 1) return "úkol";
  if (n >= 2 && n <= 4) return "úkoly";
  return "úkolů";
}
