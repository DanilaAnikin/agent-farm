// /suggestions (/navrhy): proaktivní návrhy farmy „co dál" — univerzální
// (feature/fix/test/automation/integration/research/refactor/content/opportunity…),
// projektové i napříč projekty. Přijetí → přání, zahození → dismissed.
import { Bot, InlineKeyboard } from "grammy";
import type { BotContext } from "./types.js";
import { b, escapeHtml, kindEmoji } from "./format.js";
import {
  acceptSuggestionForUser,
  dismissSuggestionForUser,
  getNewSuggestions,
  type SuggestionRow,
} from "./db-helpers.js";

// Kolik návrhů maximálně vypíšeme na jednu žádost (throttle proti zaplavení).
const MAX_LIST = 10;

function shortDesc(s: SuggestionRow): string {
  const d = s.description.trim();
  if (d === "") return "";
  return d.length > 160 ? `${d.slice(0, 159)}…` : d;
}

/** Sestaví text jedné karty návrhu (HTML). */
function suggestionCard(s: SuggestionRow): string {
  const scope = s.projectName ? b(s.projectName) : b("napříč projekty");
  const lines = [`${kindEmoji(s.kind)} ${scope} · ${escapeHtml(s.kind)}`, b(s.title)];
  const desc = shortDesc(s);
  if (desc) lines.push(escapeHtml(desc));
  return lines.join("\n");
}

function cardKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Přijmout", `sug:accept:${id}`)
    .text("✖️ Zahodit", `sug:dismiss:${id}`);
}

export function registerSuggestions(bot: Bot<BotContext>): void {
  const listHandler = async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) return;
    const rows = await getNewSuggestions(user.userId, MAX_LIST + 5);
    if (rows.length === 0) {
      await ctx.reply(
        "Farma zatím nemá návrhy — jakmile projekt pochopí, začne navrhovat co dál. 💡",
      );
      return;
    }
    const shown = rows.slice(0, MAX_LIST);
    await ctx.reply(
      `${b("💡 Návrhy farmy")} — co dál (${shown.length}${rows.length > MAX_LIST ? "+" : ""})`,
      { parse_mode: "HTML" },
    );
    for (const s of shown) {
      await ctx.reply(suggestionCard(s), {
        parse_mode: "HTML",
        reply_markup: cardKeyboard(s.id),
        link_preview_options: { is_disabled: true },
      });
    }
  };
  bot.command("suggestions", (ctx) => listHandler(ctx));
  bot.command("navrhy", (ctx) => listHandler(ctx));

  // ✅ Přijmout → z návrhu vznikne přání (nebo 'accepted' u návrhu napříč projekty).
  bot.callbackQuery(/^sug:accept:([0-9a-fA-F-]{36})$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const res = await acceptSuggestionForUser(user.userId, id);
    await ctx.answerCallbackQuery({ text: res.ok ? "Přijato ✅" : "Nelze" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(res.text);
  });

  // ✖️ Zahodit → dismissed.
  bot.callbackQuery(/^sug:dismiss:([0-9a-fA-F-]{36})$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const res = await dismissSuggestionForUser(user.userId, id);
    await ctx.answerCallbackQuery({ text: res.ok ? "Zahozeno ✖️" : "Nelze" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(res.text);
  });
}
