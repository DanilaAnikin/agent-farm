// Bohaté read příkazy: /projects, /project, /agents (/bots), /status, /digest,
// /help + inline detail projektu s akčními tlačítky.
import { Bot, InlineKeyboard } from "grammy";
import { chat, MODELS } from "@farm/llm";
import type { BotContext } from "./types.js";
import { formatUsd } from "./types.js";
import {
  b,
  escapeHtml,
  humanizeDuration,
  progressBar,
  statusBadge,
} from "./format.js";
import { transitionProject } from "./actions.js";
import { setActiveProject, setAwaitingNote } from "./session.js";
import {
  findUserProject,
  getActiveWishes,
  getPendingApprovalsCount,
  getProjectRunningAgentRows,
  getProjectTaskProgress,
  getProjectTodaySpend,
  getRecentProjectEvents,
  getRecentUserEvents,
  getUserMonthSpend,
  getUserProjects,
  getUserRunningAgents,
  getUserTodaySpend,
  getWishTaskProgress,
} from "./db-helpers.js";
import type { ProjectRow, RunningAgentRow } from "./db-helpers.js";

// Agent s heartbeatem novějším než tohle je "živý".
const AGENT_FRESH_MS = Number(process.env.TELEGRAM_AGENT_FRESH_MS ?? 120000);
const agentCutoff = (): Date => new Date(Date.now() - AGENT_FRESH_MS);

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

export function registerViews(bot: Bot<BotContext>): void {
  // --- /projects ------------------------------------------------------------
  bot.command("projects", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const rows = await getUserProjects(user.userId);
    if (rows.length === 0) {
      await ctx.reply("Zatím nemáš žádné projekty. Založ si první v dashboardu.");
      return;
    }
    const lines: string[] = [b("📊 Tvoje projekty"), ""];
    const kb = new InlineKeyboard();
    for (const p of rows) {
      const [spend, progress, wishesActive] = await Promise.all([
        getProjectTodaySpend(p.id),
        getProjectTaskProgress(p.id),
        getActiveWishes(p.id),
      ]);
      lines.push(
        `${b(p.name)} — ${statusBadge(p.status)}\n` +
          `${progressBar(progress.done, progress.total)} · přání: ${wishesActive.length} · dnes ${escapeHtml(formatUsd(spend))}`,
      );
      kb.text(`🔎 ${p.name}`, `proj:open:${p.id}`).row();
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  });

  // --- /project <name|id> ---------------------------------------------------
  bot.command("project", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const name = String(ctx.match ?? "").trim();
    if (name === "") {
      await ctx.reply("Použití: /project <projekt>");
      return;
    }
    const project = await findUserProject(user.userId, name);
    if (!project) {
      await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
      return;
    }
    const { text, keyboard } = await renderProjectDetail(user.userId, project);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  });

  // --- /agents + /bots ------------------------------------------------------
  const agentsHandler = async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) return;
    const rows = await getUserRunningAgents(user.userId, agentCutoff());
    const busy = rows.filter((r) => r.status === "busy");
    if (rows.length === 0) {
      await ctx.reply("💤 Právě nikdo nepracuje. Farma čeká na práci nebo je pozastavená.");
      return;
    }
    const lines: string[] = [b("🤖 Kdo právě pracuje"), ""];
    for (const a of rows) {
      const proj = a.projectName ? escapeHtml(a.projectName) : "?";
      const task = a.taskTitle ? ` — „${escapeHtml(a.taskTitle)}“` : a.status === "busy" ? "" : " (čeká)";
      const model = a.model ? ` ${escapeHtml(a.model)}` : "";
      lines.push(`${roleLabel(a.role)}${model} · ${b(proj)}${task}\n   ⏱ ${agentDuration(a)}`);
    }
    lines.push("");
    lines.push(`Aktivně pracuje: ${busy.length} · živých: ${rows.length}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  };
  bot.command("agents", (ctx) => agentsHandler(ctx));
  bot.command("bots", (ctx) => agentsHandler(ctx));

  // --- /status (kompaktní přehled farmy) ------------------------------------
  bot.command("status", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const projectsRows = await getUserProjects(user.userId);
    if (projectsRows.length === 0) {
      await ctx.reply("Zatím nemáš žádné projekty. Založ si první v dashboardu.");
      return;
    }
    const [running, todaySpend, monthSpend, pending] = await Promise.all([
      getUserRunningAgents(user.userId, agentCutoff()),
      getUserTodaySpend(user.userId),
      getUserMonthSpend(user.userId),
      getPendingApprovalsCount(user.userId),
    ]);
    const busy = running.filter((r) => r.status === "busy").length;
    const active = projectsRows.filter((p) => p.status === "active").length;
    const attention = projectsRows.filter(
      (p) => p.status === "paused" || p.status === "budget_hold" || p.status === "stopped",
    ).length;

    const lines: string[] = [
      b("🌱 Přehled farmy"),
      "",
      `📁 Projekty: ${projectsRows.length} (▶️ ${active} aktivních)`,
      `🤖 Právě pracuje: ${busy} agentů`,
      `💵 Dnes: ${escapeHtml(formatUsd(todaySpend))} · tento měsíc: ${escapeHtml(formatUsd(monthSpend))}`,
    ];
    const flags: string[] = [];
    if (pending > 0) flags.push(`📝 ${pending} ke schválení`);
    if (attention > 0) flags.push(`⚠️ ${attention} vyžaduje pozornost`);
    if (flags.length > 0) {
      lines.push("");
      lines.push(flags.join(" · "));
    }
    lines.push("");
    lines.push("Detail: /projects · /agents · /digest");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // --- /digest (NL shrnutí za 24 h přes @farm/llm) --------------------------
  bot.command("digest", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const evs = await getRecentUserEvents(user.userId, since, 60);
    if (evs.length === 0) {
      await ctx.reply("Za posledních 24 h se toho na farmě moc nedělo. 🌙");
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    // Kompaktní vstup pro model (šetříme tokeny).
    const bullets = evs
      .slice()
      .reverse()
      .map((e) => `[${e.projectName ?? "?"}] ${e.type}: ${e.message}`.slice(0, 200))
      .join("\n");
    try {
      const res = await chat({
        model: MODELS.cheap,
        temperature: 0.4,
        maxTokens: 320,
        metadata: { userId: user.userId, scope: "system" },
        messages: [
          {
            role: "system",
            content:
              "Jsi asistent farmy AI agentů. Ze seznamu událostí za posledních 24 hodin " +
              "napiš uživateli přátelské české shrnutí (3–5 vět). Zmiň konkrétní projekty, " +
              "co se dokončilo a co případně čeká na jeho rozhodnutí. Nevymýšlej si nic, co " +
              "není v datech. Bez odrážek, plynulý text.",
          },
          { role: "user", content: `Události:\n${bullets}` },
        ],
      });
      const text = res.content.trim();
      await ctx.reply(text.length > 0 ? `📰 ${text}` : fallbackDigest(evs.length), {
        parse_mode: "HTML",
      });
    } catch {
      await ctx.reply(fallbackDigest(evs.length));
    }
  });

  // --- /help ----------------------------------------------------------------
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  // --- inline callbacky detailu projektu ------------------------------------
  bot.callbackQuery(/^proj:open:(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const id = ctx.match?.[1];
    const project = id ? await findUserProject(user.userId, id) : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    await ctx.answerCallbackQuery();
    const { text, keyboard } = await renderProjectDetail(user.userId, project);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.callbackQuery(/^proj:(pause|resume):(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const dir = ctx.match?.[1];
    const id = ctx.match?.[2];
    const project = id ? await findUserProject(user.userId, id) : undefined;
    if (!project || !dir) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    const result = await transitionProject(project, dir === "pause" ? "paused" : "active");
    await ctx.answerCallbackQuery({ text: result.ok ? "Hotovo" : "Nelze" });
    await ctx.reply(result.text);
  });

  bot.callbackQuery(/^proj:msg:(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const chatId = ctx.chat?.id;
    const id = ctx.match?.[1];
    const project = id ? await findUserProject(user.userId, id) : undefined;
    if (!project || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    setActiveProject(chatId, { id: project.id, name: project.name });
    await ctx.answerCallbackQuery({ text: "Aktivní projekt nastaven ✍️" });
    await ctx.reply(
      `✍️ Piš. Každou zprávu založím jako přání do projektu „${project.name}“.\n(Přepnout: /use <jiný projekt>)`,
    );
  });

  bot.callbackQuery(/^proj:note:(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const chatId = ctx.chat?.id;
    const id = ctx.match?.[1];
    const project = id ? await findUserProject(user.userId, id) : undefined;
    if (!project || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    setAwaitingNote(chatId, { id: project.id, name: project.name });
    await ctx.answerCallbackQuery({ text: "Napiš poznámku 📝" });
    await ctx.reply(`📝 Napiš poznámku pro manažera projektu „${project.name}“ (další zpráva).`);
  });

  bot.callbackQuery(/^proj:activity:(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const id = ctx.match?.[1];
    const project = id ? await findUserProject(user.userId, id) : undefined;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    await ctx.answerCallbackQuery();
    const evs = await getRecentProjectEvents(project.id, 10);
    if (evs.length === 0) {
      await ctx.reply(`Žádná aktivita v projektu „${project.name}“.`);
      return;
    }
    const lines = [b(`🔎 Aktivita — ${project.name}`), ""];
    for (const e of evs) {
      lines.push(`${escapeHtml(fmtTime(e.ts))} · ${escapeHtml(e.type)}\n   ${escapeHtml(e.message)}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });
}

/** Sestaví text + tlačítka detailu projektu. */
async function renderProjectDetail(
  userId: string,
  project: ProjectRow,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const [spend, progress, activeWishes, agentsRows, recent] = await Promise.all([
    getProjectTodaySpend(project.id),
    getProjectTaskProgress(project.id),
    getActiveWishes(project.id),
    getProjectRunningAgentRows(project.id, agentCutoff()),
    getRecentProjectEvents(project.id, 5),
  ]);

  const lines: string[] = [
    `${b(project.name)} — ${statusBadge(project.status)}`,
    `${progressBar(progress.done, progress.total)} (${progress.done}/${progress.total} úkolů)`,
    `💵 Dnes ${escapeHtml(formatUsd(spend))} / strop ${escapeHtml(formatUsd(project.dailyCapUsd))} · zbývá ${escapeHtml(formatUsd(Math.max(0, project.dailyCapUsd - spend)))}`,
  ];
  if (project.managerNote) {
    lines.push(`📝 Poznámka: ${escapeHtml(project.managerNote)}`);
  }

  lines.push("", b("Aktivní přání:"));
  if (activeWishes.length === 0) {
    lines.push("(žádná — napiš zprávu a přidej nové)");
  } else {
    for (const w of activeWishes) {
      const wp = await getWishTaskProgress(w.id);
      const bar = wp.total > 0 ? ` ${progressBar(wp.done, wp.total)}` : "";
      lines.push(`• „${escapeHtml(w.title)}“ — ${escapeHtml(w.status)}${bar}`);
    }
  }

  lines.push("", b("Právě běží:"));
  if (agentsRows.length === 0) {
    lines.push("(nikdo právě nepracuje)");
  } else {
    for (const a of agentsRows) {
      const task = a.taskTitle ? ` — „${escapeHtml(a.taskTitle)}“` : "";
      const model = a.model ? ` ${escapeHtml(a.model)}` : "";
      lines.push(`• ${roleLabel(a.role)}${model}${task} · ⏱ ${agentDuration(a)}`);
    }
  }

  if (recent.length > 0) {
    lines.push("", b("Poslední aktivita:"));
    for (const e of recent) {
      lines.push(`· ${escapeHtml(fmtTime(e.ts))} ${escapeHtml(e.type)} — ${escapeHtml(e.message)}`);
    }
  }

  const kb = new InlineKeyboard();
  if (project.status === "active") kb.text("⏸ Pauza", `proj:pause:${project.id}`);
  else kb.text("▶️ Pokračovat", `proj:resume:${project.id}`);
  kb.text("✍️ Nová zpráva", `proj:msg:${project.id}`).row();
  kb.text("📝 Poznámka manažerovi", `proj:note:${project.id}`);
  kb.text("🔎 Aktivita", `proj:activity:${project.id}`);

  return { text: lines.join("\n"), keyboard: kb };
}

function fmtTime(ts: Date): string {
  return ts.toISOString().slice(5, 16).replace("T", " ");
}

function fallbackDigest(n: number): string {
  return `📰 Za posledních 24 h proběhlo ${n} událostí. Detail: /projects nebo /agents.`;
}

const HELP_TEXT = [
  b("🌱 Perennial — nápověda"),
  "",
  b("Přehledy"),
  "/status — kompaktní přehled farmy",
  "/projects — všechny projekty s progresem",
  "/project <projekt> — detail projektu + akce",
  "/agents (/bots) — kdo právě pracuje",
  "/swarm (/roj) — velín roje: živý snímek paralelismu",
  "/suggestions (/navrhy) — návrhy farmy, co dál",
  "/digest — shrnutí posledních 24 h",
  "",
  b("Zadávání a řízení"),
  "/use <projekt> — nastav aktivní projekt (pak stačí psát)",
  "/wish <projekt> <text> — založ přání",
  "/say <projekt> <text> — totéž (přirozeně)",
  "/note <projekt> <text> — poznámka manažerovi",
  "🎤 hlasovka — také se stane přáním",
  "",
  b("Správa"),
  "/pause <projekt> · /resume <projekt>",
  "/budget <projekt> <usd> — denní strop",
  "/kill — nouzová globální pauza (admin)",
  "",
  "Schválení a reporty ti chodí sem automaticky. 🤖",
].join("\n");
