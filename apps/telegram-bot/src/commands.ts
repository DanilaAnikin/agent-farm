// Správní příkazy: /pause, /resume, /budget, /note, /kill.
// (Přehledové příkazy /status, /projects, … jsou ve views.ts.)
import { Bot } from "grammy";
import { getDb, projects, farmSettings } from "@farm/db";
import { eq } from "drizzle-orm";
import type { BotContext } from "./types.js";
import { formatUsd } from "./types.js";
import { findUserProject, insertEvent } from "./db-helpers.js";
import { saveManagerNote, transitionProject } from "./actions.js";

export function registerCommands(bot: Bot<BotContext>): void {
  // /pause <projekt>
  bot.command("pause", async (ctx) => {
    await handleTransition(ctx, "paused");
  });

  // /resume <projekt>
  bot.command("resume", async (ctx) => {
    await handleTransition(ctx, "active");
  });

  // /budget <projekt> <usd> — nastaví denní strop projektu.
  bot.command("budget", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.length < 2) {
      await ctx.reply("Použití: /budget <projekt> <usd>");
      return;
    }
    const usdRaw = args[args.length - 1] ?? "";
    const name = args.slice(0, -1).join(" ");
    const usd = Number(usdRaw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(usd) || usd <= 0) {
      await ctx.reply("Neplatná částka. Použití: /budget <projekt> <usd>");
      return;
    }
    const project = await findUserProject(user.userId, name);
    if (!project) {
      await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
      return;
    }
    await getDb()
      .update(projects)
      .set({ dailyCapUsd: usd, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    await insertEvent({
      projectId: project.id,
      type: "budget_changed",
      level: "info",
      message: `Denní strop nastaven na ${formatUsd(usd)} přes Telegram.`,
      data: { dailyCapUsd: usd, via: "telegram" },
    });
    await ctx.reply(`✅ Denní strop projektu „${project.name}“ je teď ${formatUsd(usd)}.`);
  });

  // /note <projekt> <text> — poznámka manažerovi (steeruje refill).
  bot.command("note", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const raw = (ctx.match ?? "").trim();
    const firstSpace = raw.search(/\s/);
    if (firstSpace < 0) {
      await ctx.reply("Použití: /note <projekt> <text>");
      return;
    }
    const name = raw.slice(0, firstSpace);
    const note = raw.slice(firstSpace + 1).trim();
    if (note === "") {
      await ctx.reply("Použití: /note <projekt> <text>");
      return;
    }
    const project = await findUserProject(user.userId, name);
    if (!project) {
      await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
      return;
    }
    await saveManagerNote(project, note);
    await ctx.reply(`✅ Poznámka manažerovi projektu „${project.name}“ uložena.`);
  });

  // /kill — ADMIN: global_pause + orchestrátor aborte běžící sessions.
  bot.command("kill", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    if (user.role !== "admin") {
      await ctx.reply("⛔ Tento příkaz může použít jen admin.");
      return;
    }
    // `owner_pause`, ne `global_pause`: druhý klíč patří automatickým hlídačům,
    // které si ho podle `pause_source` samy vypínají — kill switch od člověka by
    // jim tak padl za oběť. Orchestrátor bere oba stejně vážně (isGlobalPaused).
    await getDb()
      .insert(farmSettings)
      .values({ key: "owner_pause", value: true })
      .onConflictDoUpdate({
        target: farmSettings.key,
        set: { value: true, updatedAt: new Date() },
      });
    await insertEvent({
      type: "global_pause",
      level: "warn",
      message: "KILL SWITCH: global_pause=true přes Telegram. Orchestrátor aborte běžící sessions.",
      data: { via: "telegram", by: user.userId },
    });
    await ctx.reply(
      "🛑 KILL SWITCH aktivní.\nFarma je globálně pozastavena (global_pause=true). Orchestrátor přeruší běžící sessions před dalším dispatchem. Obnovení proveď v dashboardu.",
    );
  });
}

async function handleTransition(ctx: BotContext, to: "paused" | "active"): Promise<void> {
  const user = ctx.user;
  if (!user) return;
  const name = String(ctx.match ?? "").trim();
  if (name === "") {
    await ctx.reply(`Použití: /${to === "paused" ? "pause" : "resume"} <projekt>`);
    return;
  }
  const project = await findUserProject(user.userId, name);
  if (!project) {
    await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
    return;
  }
  const result = await transitionProject(project, to);
  await ctx.reply(result.text);
}
