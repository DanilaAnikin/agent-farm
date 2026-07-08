// Reporter: sleduje `events` a pushuje proaktivní reporty do Telegramu vlastníka.
// "Agenti mi reportují, že něco dodělali / v jakém je to stádiu."
//
// Durabilita: kurzor posledního reportovaného eventu per chat je uložen v
// farm_settings pod klíčem `tg_report_cursor:<chatId>` (ISO ts). Po restartu
// se nespamuje ani neztrácí. Řadíme podle events.ts (id je náhodné uuid).
import { Bot } from "grammy";
import type { BotContext } from "./types.js";
import { formatReport } from "./format.js";
import { getPairedProfiles, getReportEvents, getSetting, setSetting } from "./db-helpers.js";

const POLL_MS = Number(process.env.TELEGRAM_REPORT_POLL_MS ?? 8000);
// Max reportů na jeden chat za tick (throttle proti zaplavení).
const MAX_PER_TICK = Number(process.env.TELEGRAM_REPORT_MAX_PER_TICK ?? 12);
// Rozestup mezi zprávami (ms) — šetrné k Telegram rate-limitům.
const THROTTLE_MS = Number(process.env.TELEGRAM_REPORT_THROTTLE_MS ?? 350);

const cursorKey = (chatId: string): string => `tg_report_cursor:${chatId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spustí polling proaktivních reportů. Vrací interval. */
export function startReporter(bot: Bot<BotContext>): NodeJS.Timeout {
  // In-memory cache kurzorů (ISO ts), aby se nečetlo farm_settings každý tick.
  const cursors = new Map<string, string>();

  const loadCursor = async (chatId: string): Promise<string> => {
    const cached = cursors.get(chatId);
    if (cached !== undefined) return cached;
    const stored = await getSetting(cursorKey(chatId));
    let iso: string;
    if (typeof stored === "string") {
      iso = stored;
    } else {
      // První spuštění pro tento chat — začni od teď (nespamuj historii).
      iso = new Date().toISOString();
      await setSetting(cursorKey(chatId), iso);
    }
    cursors.set(chatId, iso);
    return iso;
  };

  const reportForUser = async (userId: string, chatId: string): Promise<void> => {
    const cursor = await loadCursor(chatId);
    const rows = await getReportEvents(userId, new Date(cursor), MAX_PER_TICK);
    if (rows.length === 0) return;

    let newCursor = cursor;
    for (const e of rows) {
      newCursor = e.ts.toISOString();
      const msg = formatReport({
        type: e.type,
        message: e.message,
        data: e.data,
        projectName: e.projectName,
      });
      if (!msg) continue; // typ neumíme — kurzor stejně posuneme
      try {
        await bot.api.sendMessage(chatId, msg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch {
        // Chat nedostupný (blok/smazán) — kurzor posuneme, ať necyklíme donekonečna.
      }
      await sleep(THROTTLE_MS);
    }

    if (newCursor !== cursor) {
      // Kurzor je ms-přesný, ale event.ts v Postgresu má mikrosekundy → prosté
      // `ts > cursor(ms)` by poslední event posílalo donekonečna. Posun o +1 ms ho
      // vyřadí. ALE když byl batch PLNÝ (rows.length === MAX_PER_TICK), možná jsme
      // uřízli burst uprostřed jedné ms — pak +1 ms NEDĚLÁME (skiplo by nedoručené
      // eventy téže ms); necháme přesný ts (příště se pár znovu načte = duplikáty,
      // ale nic se neztratí).
      const baseMs = new Date(newCursor).getTime();
      const truncated = rows.length >= MAX_PER_TICK;
      const next = new Date(truncated ? baseMs : baseMs + 1).toISOString();
      cursors.set(chatId, next);
      await setSetting(cursorKey(chatId), next);
    }
  };

  const tick = async (): Promise<void> => {
    try {
      const paired = await getPairedProfiles();
      for (const p of paired) {
        try {
          await reportForUser(p.userId, p.chatId);
        } catch {
          // chyba jednoho uživatele nesmí shodit celý tick
        }
      }
    } catch {
      // DB výpadek — tichý retry v dalším ticku
    }
  };

  void tick();
  return setInterval(() => void tick(), POLL_MS);
}
