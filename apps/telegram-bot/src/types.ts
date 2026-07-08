// Sdílené typy a pomocníci pro Telegram bota.
import type { Context } from "grammy";
import { profiles } from "@farm/db";

/** Řádek profilu uživatele (z DB). */
export type ProfileRow = typeof profiles.$inferSelect;

/**
 * Rozšířený grammY kontext — middleware `requirePairing` sem připojí
 * spárovaný profil uživatele (`ctx.user`).
 */
export interface BotContext extends Context {
  user?: ProfileRow;
}

/** Přečte povinnou env proměnnou nebo spadne s českou chybou. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Chybí povinná proměnná prostředí ${name}. Doplň ji do .env.`);
  }
  return v;
}

/** Formátování částky v USD pro zprávy. */
export function formatUsd(v: number): string {
  return `$${(Math.round(v * 100) / 100).toFixed(2)}`;
}

/** Začátek dnešního UTC dne (pro denní stropy / spend). */
export function startOfUtcDay(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Začátek aktuálního UTC měsíce (pro měsíční spend). */
export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
