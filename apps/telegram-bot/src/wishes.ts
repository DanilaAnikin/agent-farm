// Přání: text i hlasovka → přání. S aktivním projektem (/use) stačí psát;
// jinak se zeptáme na projekt inline tlačítky. Text může být i poznámka
// manažerovi (po kliknutí na 📝 Poznámka v detailu projektu).
import { Bot, InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";
import { getDb, wishes } from "@farm/db";
import { createStorage } from "@farm/storage";
import type { BotContext } from "./types.js";
import { requireEnv } from "./types.js";
import { findUserProject, getUserProjects, insertEvent } from "./db-helpers.js";
import { createTextWish, saveManagerNote } from "./actions.js";
import { clearSessions, getActiveProject, takeAwaitingNote } from "./session.js";

/**
 * Rozpracované přání čekající na výběr/potvrzení projektu (in-memory, per chat).
 * POZOR (durabilita): po restartu bota se ztratí. Pro v1 stačí — uživatel
 * přání prostě pošle znovu.
 */
type PendingWish =
  | { kind: "text"; text: string }
  | { kind: "voice"; storagePath: string };

const pending = new Map<number, PendingWish>();

/** Nastaví draft a uklidí OSIŘELÉ audio předchozího hlasového draftu (jakýkoliv
 *  nový draft ho přepisuje — i textový). Jinak by nahrané .ogg zůstalo ve storage. */
async function setPendingDraft(chatId: number, draft: PendingWish): Promise<void> {
  const prev = pending.get(chatId);
  const keepsSameAudio = draft.kind === "voice" && prev?.kind === "voice" && draft.storagePath === prev.storagePath;
  if (prev?.kind === "voice" && prev.storagePath && !keepsSameAudio) {
    await createStorage().remove(prev.storagePath).catch(() => undefined);
  }
  pending.set(chatId, draft);
}

async function askProject(ctx: BotContext, userId: string): Promise<void> {
  const projects = await getUserProjects(userId);
  if (projects.length === 0) {
    await ctx.reply("Nemáš žádný projekt. Založ si první v dashboardu a zkus to znovu.");
    return;
  }
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(p.name, `wish:${p.id}`).row();
  }
  await ctx.reply("Do kterého projektu přání patří?", { reply_markup: kb });
}

export function registerWishes(bot: Bot<BotContext>): void {
  // Prostý text (ne příkaz) → poznámka manažerovi / přání do aktivního projektu / výběr.
  bot.on("message:text", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // neznámý příkaz — ignoruj
    const chatId = ctx.chat.id;

    // 1) Čeká se na poznámku manažerovi (z tlačítka 📝)?
    const notePending = takeAwaitingNote(chatId);
    if (notePending) {
      const project = await findUserProject(user.userId, notePending.id);
      if (!project) {
        await ctx.reply("Projekt už neexistuje.");
        return;
      }
      await saveManagerNote(project, text);
      await ctx.reply(`✅ Poznámka manažerovi projektu „${project.name}“ uložena.`);
      return;
    }

    // 2) Je nastaven aktivní projekt (/use nebo ✍️)? → potvrď přání tapnutím.
    const active = getActiveProject(chatId);
    if (active) {
      const project = await findUserProject(user.userId, active.id);
      if (project) {
        await setPendingDraft(chatId, { kind: "text", text });
        const kb = new InlineKeyboard()
          .text(`✅ Založit v „${project.name}“`, `wish:${project.id}`)
          .text("↩︎ Jiný projekt", "wish:pick");
        await ctx.reply(`Nové přání do „${project.name}“?`, { reply_markup: kb });
        return;
      }
    }

    // 3) Fallback: zeptej se na projekt.
    await setPendingDraft(chatId, { kind: "text", text });
    await askProject(ctx, user.userId);
  });

  // Hlasovka → stáhnout přes getFile, nahrát do Storage, čeká na projekt.
  bot.on("message:voice", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const chatId = ctx.chat.id;
    try {
      const token = requireEnv("TELEGRAM_BOT_TOKEN");
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("Nepodařilo se získat hlasový soubor. Zkus to prosím znovu.");
        return;
      }
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        await ctx.reply("Stažení hlasovky selhalo. Zkus to prosím znovu.");
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const assetId = randomUUID();
      const storagePath = `users/${user.userId}/voice/${assetId}.ogg`;
      await createStorage().put(storagePath, buf, "audio/ogg");
      // setPendingDraft uklidí osiřelé audio případného předchozího hlasového draftu.
      await setPendingDraft(chatId, { kind: "voice", storagePath });

      // S aktivním projektem rovnou potvrď, jinak se zeptej.
      const active = getActiveProject(chatId);
      const activeProject = active ? await findUserProject(user.userId, active.id) : undefined;
      if (activeProject) {
        const kb = new InlineKeyboard()
          .text(`✅ Založit v „${activeProject.name}“`, `wish:${activeProject.id}`)
          .text("↩︎ Jiný projekt", "wish:pick");
        await ctx.reply(`🎤 Hlasovka do „${activeProject.name}“?`, { reply_markup: kb });
      } else {
        await askProject(ctx, user.userId);
      }
    } catch (err) {
      await ctx.reply(
        `Zpracování hlasovky selhalo: ${(err as Error).message ?? "neznámá chyba"}`,
      );
    }
  });

  // "Jiný projekt" → přepni na výběr, draft zůstává v paměti.
  bot.callbackQuery("wish:pick", async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await askProject(ctx, user.userId);
  });

  // Výběr/potvrzení projektu → vytvoř wish.
  bot.callbackQuery(/^wish:([0-9a-fA-F-]{36})$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const projectId = ctx.match?.[1];
    if (!projectId) {
      await ctx.answerCallbackQuery();
      return;
    }
    // Ověř, že projekt patří uživateli.
    const projects = await getUserProjects(user.userId);
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Neznámý projekt." });
      return;
    }
    const draft = pending.get(chatId);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Přání vypršelo, pošli ho znovu." });
      await ctx.editMessageText("Přání už není v paměti — pošli ho prosím znovu.");
      return;
    }
    pending.delete(chatId);

    if (draft.kind === "text") {
      await createTextWish(project, draft.text);
      await ctx.answerCallbackQuery({ text: "Přání založeno ✅" });
      await ctx.editMessageText(
        `✅ Přání zařazeno do projektu „${project.name}“. Manager z něj připraví specifikaci.`,
      );
      return;
    }

    // Hlasové přání: placeholder description + event pro STT smyčku orchestrátoru.
    const inserted = await getDb()
      .insert(wishes)
      .values({
        projectId: project.id,
        title: "🎤 Hlasové přání (čeká na přepis)",
        description: `[voice] ${draft.storagePath}`,
        source: "voice",
        status: "new",
      })
      .returning({ id: wishes.id });
    const wishId = inserted[0]?.id;
    // KONTRAKT s orchestrátorem: STT smyčka čte events type='voice_wish',
    // stáhne audio z data.storagePath, přepíše (Groq Whisper) a doplní
    // wishes.title/description pro wishId.
    await insertEvent({
      projectId: project.id,
      wishId: wishId ?? null,
      type: "voice_wish",
      level: "info",
      message: "Hlasové přání čeká na přepis (STT).",
      data: { storagePath: draft.storagePath, wishId: wishId ?? null, source: "voice" },
    });
    await ctx.answerCallbackQuery({ text: "Hlasovka nahrána ✅" });
    await ctx.editMessageText(
      `✅ Hlasovka zařazena do projektu „${project.name}“. Jakmile ji orchestrátor přepíše, manager připraví specifikaci.`,
    );
  });
}

// Úklid při shutdownu.
export function clearPendingWishes(): void {
  pending.clear();
  clearSessions();
}
