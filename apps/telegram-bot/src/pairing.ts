// Párování Telegram účtu s profilem uživatele + auth middleware.
import { Bot } from "grammy";
import { getDb, profiles } from "@farm/db";
import { eq } from "drizzle-orm";
import type { BotContext } from "./types.js";

/**
 * Registruje `/start [kód]` a middleware `requirePairing`.
 * POŘADÍ: nejdřív `/start` (funguje i pro nespárované), pak middleware,
 * takže všechny ostatní handlery už mají `ctx.user`.
 */
export function registerPairing(bot: Bot<BotContext>): void {
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const code = (ctx.match ?? "").trim();

    // Už spárováno na tento chat?
    const existing = await getDb()
      .select()
      .from(profiles)
      .where(eq(profiles.telegramChatId, String(chatId)))
      .limit(1);
    if (existing[0]) {
      await ctx.reply(
        `Ahoj ${existing[0].displayName ?? ""}! Účet je spárovaný. Napiš /status pro přehled projektů.`,
      );
      return;
    }

    if (code === "") {
      await ctx.reply(
        "Vítej v Perennial 🤖\n\nÚčet zatím není spárovaný. V dashboardu (/settings → Telegram) si vygeneruj párovací kód a pošli:\n/start <kód>",
      );
      return;
    }

    // Najdi profil podle párovacího kódu.
    const match = await getDb()
      .select()
      .from(profiles)
      .where(eq(profiles.telegramPairingCode, code))
      .limit(1);
    const profile = match[0];
    if (!profile) {
      await ctx.reply("Neplatný nebo prošlý párovací kód. Vygeneruj nový v dashboardu.");
      return;
    }
    // Expirace (15 min) — proti brute-force / trvale platnému kódu = převzetí účtu.
    const exp = profile.telegramPairingExpiresAt;
    if (!exp || new Date(exp).getTime() < Date.now()) {
      await ctx.reply("Párovací kód vypršel. Vygeneruj nový v dashboardu (/settings → Telegram).");
      return;
    }

    // Ulož chat id a spotřebuj kód (jednorázový, i expiraci vynuluj).
    await getDb()
      .update(profiles)
      .set({ telegramChatId: String(chatId), telegramPairingCode: null, telegramPairingExpiresAt: null })
      .where(eq(profiles.userId, profile.userId));

    await ctx.reply(
      `Hotovo ✅ Účet je spárovaný. Budeš tu dostávat schválení a alerty.\nNapiš /status pro přehled projektů.`,
    );
  });

  // Auth: pro vše kromě /start vyžaduj spárování.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      // Update bez chatu (např. inline query) — ignoruj.
      return;
    }
    const rows = await getDb()
      .select()
      .from(profiles)
      .where(eq(profiles.telegramChatId, String(chatId)))
      .limit(1);
    const profile = rows[0];
    if (!profile) {
      await ctx.reply(
        "Nejsi spárovaný. Vygeneruj párovací kód v dashboardu a pošli /start <kód>.",
      );
      return; // nevoláme next() → zastavíme propagaci
    }
    ctx.user = profile;
    await next();
  });
}
