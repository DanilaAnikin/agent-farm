// /suggestions (/navrhy): návrhy farmy „co dál" a CO O NICH FARMA SAMA ROZHODLA.
// Návrhy už nečekají na schválení: farma každý nový návrh sama zadá jako přání,
// nebo ho s důvodem zahodí (duplicita, pozastavený projekt, práce napříč projekty).
// Tlačítka jsou jen nouzová zkratka — „Zadat hned" předběhne frontu, „Zahodit"
// návrh vyřadí dřív, než na něj přijde řada.
import { Bot, InlineKeyboard } from "grammy";
import type { BotContext } from "./types.js";
import { b, czPlural, escapeHtml, kindEmoji, suggestionReasonLabel } from "./format.js";
import {
  acceptSuggestionForUser,
  dismissSuggestionForUser,
  getNewSuggestions,
  getRecentSuggestionDecisions,
  type SuggestionDecisionRow,
  type SuggestionRow,
} from "./db-helpers.js";

// Kolik čekajících návrhů maximálně vypíšeme na jednu žádost (throttle proti zaplavení).
const MAX_LIST = 10;
// Kolik rozhodnutí farmy ukážeme v přehledu.
const MAX_DECISIONS = 15;
const DECISIONS_WINDOW_DAYS = 7;

function shortDesc(s: SuggestionRow): string {
  const d = s.description.trim();
  if (d === "") return "";
  return d.length > 160 ? `${d.slice(0, 159)}…` : d;
}

/** Sestaví text jedné karty čekajícího návrhu (HTML). */
function suggestionCard(s: SuggestionRow): string {
  const scope = s.projectName ? b(s.projectName) : b("napříč projekty");
  const lines = [`${kindEmoji(s.kind)} ${scope} · ${escapeHtml(s.kind)}`, b(s.title)];
  const desc = shortDesc(s);
  if (desc) lines.push(escapeHtml(desc));
  return lines.join("\n");
}

function cardKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("▶️ Zadat hned", `sug:accept:${id}`)
    .text("✖️ Zahodit", `sug:dismiss:${id}`);
}

function decisionLine(d: SuggestionDecisionRow): string {
  const icon = d.status === "converted" ? "🤖" : "✖️";
  const proj = d.projectName ? `${b(d.projectName)} · ` : "";
  const title = d.title.length > 90 ? `${d.title.slice(0, 89)}…` : d.title;
  return `${icon} ${proj}${escapeHtml(title)} — ${escapeHtml(suggestionReasonLabel(d.decidedReason))}`;
}

/** Přehled rozhodnutí farmy za posledních 7 dní (HTML). */
function decisionsSummary(decisions: SuggestionDecisionRow[]): string {
  const converted = decisions.filter((d) => d.status === "converted").length;
  const dismissed = decisions.length - converted;
  const lines = [
    `${b("🤖 Návrhy farmy")} — farma o nich rozhoduje sama`,
    `Za ${DECISIONS_WINDOW_DAYS} dní: ${czPlural(converted, ["zadané přání", "zadaná přání", "zadaných přání"])}, ` +
      `${czPlural(dismissed, ["zahozený návrh", "zahozené návrhy", "zahozených návrhů"])}.`,
  ];
  if (decisions.length > 0) {
    lines.push("", ...decisions.slice(0, MAX_DECISIONS).map(decisionLine));
  }
  return lines.join("\n");
}

export function registerSuggestions(bot: Bot<BotContext>): void {
  const listHandler = async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) return;
    const since = new Date(Date.now() - DECISIONS_WINDOW_DAYS * 24 * 3_600_000);
    const [pending, decisions] = await Promise.all([
      getNewSuggestions(user.userId, MAX_LIST + 5),
      getRecentSuggestionDecisions(user.userId, since, MAX_DECISIONS),
    ]);
    if (pending.length === 0 && decisions.length === 0) {
      await ctx.reply(
        "Farma zatím nemá žádné návrhy. Až projekty pochopí, bude sama vymýšlet a zadávat další práci. 💡",
      );
      return;
    }

    await ctx.reply(decisionsSummary(decisions), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    if (pending.length === 0) return;
    const shown = pending.slice(0, MAX_LIST);
    await ctx.reply(
      `${b("⏳ Čeká na zpracování")}: ${czPlural(pending.length, ["návrh", "návrhy", "návrhů"])}` +
        `${pending.length > MAX_LIST ? "+" : ""}. Farma je zadá sama, jakmile projekt dokončí rozdělanou práci ` +
        `(nejvýš dvě nová přání denně na projekt). Tlačítky ji můžeš předběhnout.`,
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

  // ▶️ Zadat hned → přání vznikne teď (stejná pravidla jako u farmy).
  bot.callbackQuery(/^sug:accept:([0-9a-fA-F-]{36})$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const res = await acceptSuggestionForUser(user.userId, id);
    await ctx.answerCallbackQuery({ text: res.ok ? "Zadáno ▶️" : "Nelze" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(res.text);
  });

  // ✖️ Zahodit → dismissed (důvod owner_dismissed).
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
