// Naplánovaný denní digest (template-based). Proaktivní reporty jednotlivých
// událostí řeší reporter.ts — tady jde jen o pravidelné ranní shrnutí.
import { Bot } from "grammy";
import { getDb, profiles, approvals } from "@farm/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BotContext } from "./types.js";
import { formatUsd } from "./types.js";
import {
  getUserProjects,
  getProjectTodaySpend,
  getProjectRunningAgents,
  getSetting,
  setSetting,
} from "./db-helpers.js";

const DIGEST_DAY_KEY = "tg_last_digest_day";

const DIGEST_HOUR = Number(process.env.TELEGRAM_DIGEST_HOUR_UTC ?? 7); // 07:00 UTC

/** Sestaví a pošle denní digest všem spárovaným uživatelům. */
export async function sendDailyDigest(bot: Bot<BotContext>): Promise<void> {
  const users = await getDb()
    .select({ userId: profiles.userId, chatId: profiles.telegramChatId })
    .from(profiles)
    .where(isNotNull(profiles.telegramChatId));

  for (const u of users) {
    if (!u.chatId) continue;
    try {
      const userProjects = await getUserProjects(u.userId);
      const lines: string[] = ["📅 Denní digest Perennial\n"];
      let totalSpend = 0;
      for (const p of userProjects) {
        const spend = await getProjectTodaySpend(p.id);
        const running = await getProjectRunningAgents(p.id);
        totalSpend += spend;
        lines.push(`• ${p.name} — ${p.status} · ${formatUsd(spend)} · agenti: ${running}`);
      }
      const pendingRows = await getDb()
        .select({ n: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.userId, u.userId), eq(approvals.status, "pending")));
      const pendingCount = Number(pendingRows[0]?.n ?? 0);
      lines.push("");
      lines.push(`Celkem dnes: ${formatUsd(totalSpend)}`);
      lines.push(`Čeká na schválení: ${pendingCount}`);
      if (userProjects.length === 0) lines.push("(zatím žádné projekty)");
      await bot.api.sendMessage(u.chatId, lines.join("\n"));
    } catch {
      // přeskoč uživatele při chybě
    }
  }
}

/**
 * Jednoduchý plánovač digestu: každou hodinu zkontroluje, zda je DIGEST_HOUR
 * (UTC) a zda dnes ještě neposlal. Vrací interval.
 */
export function startDigestScheduler(bot: Bot<BotContext>): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== DIGEST_HOUR) return;
    // DURABILNÍ marker (farm_settings) místo in-memory — po restartu bota se digest
    // téže hodiny neposílá dvakrát. Atomicky: přečti → pokud dnešní, skonči.
    const last = await getSetting(DIGEST_DAY_KEY).catch(() => undefined);
    if (last === day) return;
    await setSetting(DIGEST_DAY_KEY, day);
    await sendDailyDigest(bot);
  };
  return setInterval(() => void tick(), 60 * 60 * 1000); // každou hodinu
}
