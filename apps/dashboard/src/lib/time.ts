/**
 * Čas a okna.
 *
 * ZÁSADA: rozpočtová i cenová okna se POČÍTAJÍ V UTC (stejně jako `date_trunc`
 * v SQL a jako rozpočtový hlídač LiteLLM), ZOBRAZUJÍ se ale v Europe/Prague.
 * Kdyby se počítalo v místním čase, letní/zimní čas by dvakrát ročně posunul
 * hranici denního stropu a čísla v UI by přestala sedět s hlídačem.
 *
 * Bez importů z `@/` — soubor se používá i v testech přes `tsx --test`.
 */
import { APP_TIME_ZONE } from "./format";

export { APP_TIME_ZONE };

// Začátek dnešního dne v UTC (stropy se resetují 00:00 UTC — viz OVERVIEW §8).
export function startOfUtcDayIso(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return d.toISOString();
}

/** Začátek aktuálního měsíce v UTC — měsíční strop farmy se počítá od něj. */
export function startOfUtcMonthIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

// Pole ISO začátků posledních `days` UTC dnů (od nejstaršího po dnešek).
export function lastUtcDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// --- okna mimo špičku --------------------------------------------------------

/** Okno v UTC, hranice ve tvaru „HH:MM". Konec menší než začátek = okno přes půlnoc. */
export interface UtcWindow {
  start: string;
  end: string;
}

/**
 * Výchozí levné okno DeepSeeku v UTC (16:30–00:30). Farma mimo něj sama stojí,
 * protože ve špičce stojí tytéž tokeny několikanásobek. Autoritativní hodnota
 * je `farm_settings.offpeak_windows_utc`; tohle je fallback, když klíč chybí.
 * Stejná výchozí hodnota je i v migraci 0013 (funkce farm_attention).
 */
export const DEFAULT_OFFPEAK_WINDOWS_UTC: UtcWindow[] = [{ start: "16:30", end: "00:30" }];

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** „16:30" → 990 minut od půlnoci. Nevalidní vstup → null. */
export function hhmmToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Bezpečné přečtení oken ze syrového jsonb (`farm_settings.offpeak_windows_utc`). */
export function parseOffpeakWindows(raw: unknown): UtcWindow[] {
  if (!Array.isArray(raw)) return DEFAULT_OFFPEAK_WINDOWS_UTC;
  const okna: UtcWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const zacatek = (item as { start?: unknown }).start;
    const konec = (item as { end?: unknown }).end;
    if (hhmmToMinutes(zacatek) === null || hhmmToMinutes(konec) === null) continue;
    okna.push({ start: String(zacatek), end: String(konec) });
  }
  return okna.length > 0 ? okna : DEFAULT_OFFPEAK_WINDOWS_UTC;
}

function minutyUtc(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

/** Je `now` uvnitř některého levného okna? Počítá se v UTC. */
export function isOffpeakUtc(
  now: Date,
  windows: UtcWindow[] = DEFAULT_OFFPEAK_WINDOWS_UTC,
): boolean {
  const ted = minutyUtc(now);
  for (const okno of windows) {
    const od = hhmmToMinutes(okno.start);
    const do_ = hhmmToMinutes(okno.end);
    if (od === null || do_ === null) continue;
    if (od <= do_) {
      if (ted >= od && ted < do_) return true;
    } else if (ted >= od || ted < do_) {
      // okno přes půlnoc (16:30 → 00:30)
      return true;
    }
  }
  return false;
}

/**
 * Doplněk levných oken = ŠPIČKA (drahé hodiny). Vrací se v UTC a v pořadí dne.
 * Používá se jen pro popisky („farma stojí do 16:30 UTC"), ne pro rozhodování.
 */
export function peakWindowsUtc(
  windows: UtcWindow[] = DEFAULT_OFFPEAK_WINDOWS_UTC,
): UtcWindow[] {
  const hranice: Array<[number, number]> = [];
  for (const okno of windows) {
    const od = hhmmToMinutes(okno.start);
    const do_ = hhmmToMinutes(okno.end);
    if (od === null || do_ === null) continue;
    if (od <= do_) hranice.push([od, do_]);
    // Okno přes půlnoc rozpadneme na dva kusy, ať se dá doplněk spočítat lineárně.
    else hranice.push([od, 1440], [0, do_]);
  }
  if (hranice.length === 0) return [];
  hranice.sort((a, b) => a[0] - b[0]);

  const doplnek: UtcWindow[] = [];
  let kurzor = 0;
  for (const [od, do_] of hranice) {
    if (od > kurzor) doplnek.push({ start: minutesToHhmm(kurzor), end: minutesToHhmm(od) });
    kurzor = Math.max(kurzor, do_);
  }
  if (kurzor < 1440) doplnek.push({ start: minutesToHhmm(kurzor), end: "24:00" });
  return doplnek;
}

/** 990 → „16:30"; 1440 → „24:00" (konec dne, ne „00:00" následujícího). */
export function minutesToHhmm(minutes: number): string {
  const m = Math.min(1440, Math.max(0, Math.round(minutes)));
  if (m === 1440) return "24:00";
  const h = Math.floor(m / 60);
  const zb = m % 60;
  return `${String(h).padStart(2, "0")}:${String(zb).padStart(2, "0")}`;
}

/**
 * Kdy začne nejbližší levné okno? Když jsme v něm právě teď, vrátí `now`
 * (farma smí běžet hned). Bez použitelného okna vrací null.
 */
export function nextOffpeakStart(
  now: Date,
  windows: UtcWindow[] = DEFAULT_OFFPEAK_WINDOWS_UTC,
): Date | null {
  if (isOffpeakUtc(now, windows)) return now;
  const ted = minutyUtc(now);
  let nejblizsi: number | null = null;
  for (const okno of windows) {
    const od = hhmmToMinutes(okno.start);
    if (od === null) continue;
    const za = od > ted ? od - ted : od + 1440 - ted;
    if (nejblizsi === null || za < nejblizsi) nejblizsi = za;
  }
  if (nejblizsi === null) return null;
  // Zarovnáme na celou minutu, aby popisek „spustí se v 16:30" neukazoval 16:30:47.
  const zarovnano = new Date(now.getTime());
  zarovnano.setUTCSeconds(0, 0);
  return new Date(zarovnano.getTime() + nejblizsi * 60_000);
}
