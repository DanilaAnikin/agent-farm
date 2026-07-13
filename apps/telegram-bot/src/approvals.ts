// Schvalování: poll `approvals` (pending) → inline ✅/❌ s náhledem;
// callback aktualizuje status + decided_via='telegram' + decided_at.
import { Bot, InlineKeyboard } from "grammy";
import { getDb, approvals, profiles, publishRequests, enqueue, QUEUES } from "@farm/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BotContext } from "./types.js";

const POLL_MS = Number(process.env.TELEGRAM_APPROVAL_POLL_MS ?? 8000);

/**
 * Rychlý in-process guard proti dvojímu poslání v rámci běhu; DURABILITA přes
 * approvals.payload.telegram_notified_at (přežije restart bota — jinak by se po
 * restartu znovu poslaly inline prompty pro všechny stále pending approvaly).
 */
const notified = new Set<string>();

function approvalTypeLabel(type: string): string {
  switch (type) {
    case "spec":
      return "📋 Specifikace ke schválení";
    case "publish":
      return "📤 Publikace ke schválení";
    case "deploy_prod":
      return "🚀 Produkční deploy ke schválení";
    case "budget":
      return "💸 Navýšení rozpočtu ke schválení";
    case "config_change":
      return "⚙️ Změna konfigurace ke schválení";
    default:
      return `Schválení (${type})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Sestaví náhled zprávy podle typu approvalu z jeho payloadu. */
function renderPreview(type: string, payload: Record<string, unknown>): string {
  const get = (k: string): string | undefined => {
    const v = payload[k];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
  };
  const lines: string[] = [approvalTypeLabel(type), ""];
  if (type === "spec") {
    const spec = get("specMd") ?? get("contentMd") ?? get("spec") ?? "";
    if (spec) lines.push(truncate(spec, 1500));
    else lines.push("(bez náhledu specifikace)");
  } else if (type === "publish") {
    const caption = get("caption") ?? "";
    const target = get("target") ?? "instagram";
    lines.push(`Cíl: ${target}`);
    if (caption) lines.push(`Popisek: ${truncate(caption, 800)}`);
    lines.push("🎬 (video/obrázek v Content Library)");
  } else if (type === "deploy_prod") {
    const summary = get("diffSummary") ?? get("summary") ?? "";
    lines.push(summary ? truncate(summary, 1200) : "(bez souhrnu diffu)");
  } else if (type === "budget") {
    const amount = get("requestedUsd") ?? get("amountUsd") ?? get("usd") ?? "?";
    lines.push(`Požadované navýšení: $${amount}`);
  } else {
    const summary = get("summary") ?? get("message") ?? "";
    if (summary) lines.push(truncate(summary, 1200));
  }
  return lines.join("\n");
}

/** Spustí polling pending approvalů pro spárované uživatele. Vrací interval. */
export function startApprovalsPoller(bot: Bot<BotContext>): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const rows = await getDb()
        .select({
          id: approvals.id,
          userId: approvals.userId,
          type: approvals.type,
          payload: approvals.payload,
          status: approvals.status,
          expiresAt: approvals.expiresAt,
          chatId: profiles.telegramChatId,
        })
        .from(approvals)
        .innerJoin(profiles, eq(profiles.userId, approvals.userId))
        .where(
          and(
            eq(approvals.status, "pending"),
            isNotNull(profiles.telegramChatId),
            // Ještě neoznámené (durabilní marker) — přežije restart bota.
            sql`(${approvals.payload} ->> 'telegram_notified_at') IS NULL`,
          ),
        );

      const now = Date.now();
      for (const r of rows) {
        if (notified.has(r.id)) continue;
        if (!r.chatId) continue;
        if (r.expiresAt && r.expiresAt.getTime() < now) {
          // Expirované, ale stále 'pending' → stampni durabilní marker, ať vypadne
          // z dotazu. Bez toho se re-selektovalo (a přeskakovalo) každých 8 s navždy.
          const merged = {
            ...((r.payload ?? {}) as Record<string, unknown>),
            telegram_notified_at: new Date().toISOString(),
          };
          await getDb()
            .update(approvals)
            .set({ payload: merged })
            .where(eq(approvals.id, r.id))
            .catch(() => undefined);
          continue;
        }
        const kb = new InlineKeyboard()
          .text("✅ Schválit", `appr:approve:${r.id}`)
          .text("❌ Zamítnout", `appr:reject:${r.id}`);
        try {
          await bot.api.sendMessage(r.chatId, renderPreview(r.type, r.payload ?? {}), {
            reply_markup: kb,
          });
          notified.add(r.id);
          // Durabilní marker do payloadu (přežije restart) — merge, ať nepřepíšeme zbytek.
          const merged = { ...((r.payload ?? {}) as Record<string, unknown>), telegram_notified_at: new Date().toISOString() };
          await getDb().update(approvals).set({ payload: merged }).where(eq(approvals.id, r.id));
        } catch {
          // Chat nedostupný (blok/smazán) — přeskoč, zkusíme příště.
        }
      }
    } catch {
      // DB výpadek — tichý retry v dalším ticku.
    }
  };
  // Re-entrancy guard: pomalý tick (mnoho approvalů × sendMessage) nesmí běžet souběžně
  // s dalším a posílat duplicitní notifikace.
  let busy = false;
  const guardedTick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  };
  void guardedTick();
  return setInterval(() => void guardedTick(), POLL_MS);
}

/** Registruje callback handler pro rozhodnutí o approvalu. */
export function registerApprovals(bot: Bot<BotContext>): void {
  bot.callbackQuery(/^appr:(approve|reject):(.+)$/, async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    const decision = ctx.match?.[1];
    const approvalId = ctx.match?.[2];
    if (!decision || !approvalId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const rows = await getDb()
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);
    const approval = rows[0];
    if (!approval) {
      await ctx.answerCallbackQuery({ text: "Schválení neexistuje." });
      return;
    }
    if (approval.userId !== user.userId) {
      await ctx.answerCallbackQuery({ text: "Toto schválení ti nepatří." });
      return;
    }
    if (approval.status !== "pending") {
      await ctx.answerCallbackQuery({ text: "Už rozhodnuto." });
      await ctx.editMessageText(
        `${approvalTypeLabel(approval.type)}\n\nStav: ${approval.status} (už rozhodnuto).`,
      );
      return;
    }
    const newStatus = decision === "approve" ? "approved" : "rejected";
    await getDb()
      .update(approvals)
      .set({ status: newStatus, decidedVia: "telegram", decidedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));

    // Publikace: naváž stav publish_requestu a při schválení ZAŘAĎ q_publish,
    // jinak Publisher nikdy nepublikuje.
    if (approval.type === "publish") {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      const prId =
        (payload.publishRequestId as string | undefined) ??
        (payload.publish_request_id as string | undefined);
      if (typeof prId === "string") {
        await getDb()
          .update(publishRequests)
          .set({ status: decision === "approve" ? "approved" : "failed" })
          .where(eq(publishRequests.id, prId));
        if (decision === "approve") {
          await enqueue(QUEUES.publish, { publishRequestId: prId });
        }
      }
    }

    notified.delete(approvalId);
    await ctx.answerCallbackQuery({
      text: decision === "approve" ? "Schváleno ✅" : "Zamítnuto ❌",
    });
    await ctx.editMessageText(
      `${approvalTypeLabel(approval.type)}\n\n${
        decision === "approve" ? "✅ Schváleno" : "❌ Zamítnuto"
      } přes Telegram.`,
    );
  });
}
