// Dvoucestné řízení z Telegramu: /use (aktivní projekt), /wish, /say.
import { Bot } from "grammy";
import type { BotContext } from "./types.js";
import { createTextWish } from "./actions.js";
import { findUserProject } from "./db-helpers.js";
import { setActiveProject } from "./session.js";

export function registerControl(bot: Bot<BotContext>): void {
  // /use <projekt> — nastav aktivní projekt pro tento chat.
  bot.command("use", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const name = String(ctx.match ?? "").trim();
    if (name === "") {
      await ctx.reply("Použití: /use <projekt>");
      return;
    }
    const project = await findUserProject(user.userId, name);
    if (!project) {
      await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
      return;
    }
    setActiveProject(chatId, { id: project.id, name: project.name });
    await ctx.reply(
      `🎯 Aktivní projekt: „${project.name}“.\nTeď stačí psát — každou zprávu založím jako přání. (Změna: /use <jiný projekt>)`,
    );
  });

  // /wish <projekt> <text> — jednorázově založ přání.
  bot.command("wish", (ctx) => handleOneShotWish(ctx));
  // /say <projekt> <text> — alias k /wish (přirozenější).
  bot.command("say", (ctx) => handleOneShotWish(ctx));
}

async function handleOneShotWish(ctx: BotContext): Promise<void> {
  const user = ctx.user;
  if (!user) return;
  const raw = String(ctx.match ?? "").trim();
  const firstSpace = raw.search(/\s/);
  if (firstSpace < 0) {
    await ctx.reply("Použití: /wish <projekt> <text>");
    return;
  }
  const name = raw.slice(0, firstSpace);
  const text = raw.slice(firstSpace + 1).trim();
  if (text === "") {
    await ctx.reply("Použití: /wish <projekt> <text>");
    return;
  }
  const project = await findUserProject(user.userId, name);
  if (!project) {
    await ctx.reply(`Projekt „${name}“ jsem nenašel (nebo je jméno nejednoznačné).`);
    return;
  }
  await createTextWish(project, text);
  await ctx.reply(`✅ Přání zařazeno do projektu „${project.name}“. Manager z něj připraví specifikaci.`);
}
