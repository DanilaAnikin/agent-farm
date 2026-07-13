// Reporter: sleduje `events` a pushuje proaktivní reporty do Telegramu vlastníka.
// "Agenti mi reportují, že něco dodělali / v jakém je to stádiu."
//
// Durabilita: kurzor posledního reportovaného eventu per chat je uložen v
// farm_settings pod klíčem `tg_report_cursor:<chatId>` (ISO ts). Po restartu
// se nespamuje ani neztrácí. Řadíme podle events.ts (id je náhodné uuid).
import { Bot, GrammyError } from "grammy";
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

/**
 * Je chyba Telegramu PERMANENTNÍ (nemá smysl retryovat tentýž event)?
 * 403 = bot blokován / kicknut, 400 = chat neexistuje / zprávu nelze doručit.
 * Naopak 429 (rate-limit) a síťové chyby jsou přechodné → event doručíme příště.
 */
function isPermanentTelegramError(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400);
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
    let brokeEarly = false;
    for (const e of rows) {
      const ts = e.ts.toISOString();
      const msg = formatReport({
        type: e.type,
        message: e.message,
        data: e.data,
        projectName: e.projectName,
      });
      if (!msg) {
        newCursor = ts; // typ neumíme reportovat → přeskoč (posuň kurzor)
        continue;
      }
      try {
        await bot.api.sendMessage(chatId, msg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        newCursor = ts; // KURZOR posuň JEN po skutečném doručení
      } catch (err) {
        // Přechodná chyba (429 rate-limit / síť) → NEposouvej kurzor a přeruš; tenhle
        // event i jeho následníci se doručí příští tick (durabilita: „nic se neztratí").
        // Permanentní (bot blokován / chat neexistuje) → přeskoč, ať necyklíme donekonečna.
        if (!isPermanentTelegramError(err)) {
          brokeEarly = true;
          break;
        }
        newCursor = ts;
      }
      await sleep(THROTTLE_MS);
    }

    if (newCursor !== cursor) {
      // Kurzor je ms-přesný, ale event.ts v Postgresu má mikrosekundy → prosté
      // `ts > cursor(ms)` by poslední event posílalo donekonečna. Posun o +1 ms ho
      // vyřadí. ALE +1 ms je bezpečný JEN když jsme batch DOTÁHLI do konce bez uříznutí:
      //  - truncated (rows.length === MAX_PER_TICK): mohli jsme uříznout burst uvnitř 1 ms,
      //  - brokeEarly (přechodná chyba): další event téže ms je nedoručený.
      // V obou případech +1 ms NEDĚLÁME (jinak by se nedoručený event téže ms ztratil) —
      // necháme přesný ts (příště se pár znovu načte = duplikát, ale nic se neztratí).
      const baseMs = new Date(newCursor).getTime();
      const exact = rows.length >= MAX_PER_TICK || brokeEarly;
      const next = new Date(exact ? baseMs : baseMs + 1).toISOString();
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

  // Re-entrancy guard: reportForUser může jeden tick natáhnout přes POLL_MS (12 zpráv ×
  // 350 ms × N uživatelů). Bez guardu by další setInterval tick běžel souběžně, četl
  // tentýž kurzor a poslal tytéž reporty DVAKRÁT. `busy` překryv zahodí.
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
