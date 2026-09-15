/**
 * Formátovací pomůcky dashboardu — JEDINÉ místo, kde se volá Intl.
 *
 * Proč jedno místo: každá stránka si dřív formátovala peníze po svém (někde
 * `toFixed(2)`, jinde `$` před číslem, jinde Intl s jinými parametry), takže
 * stejná částka vypadala na třech obrazovkách třemi způsoby a strop „0,60"
 * se místy zobrazil jako „0,6000 $".
 *
 * ČAS: kontejner dashboardu běží v UTC, ale člověk, co se na farmu dívá, žije
 * v Praze. Všechny ZOBRAZOVANÉ časy proto formátujeme v `Europe/Prague`.
 * VÝPOČTY oken (denní/měsíční strop, off-peak) zůstávají v UTC — dělá je SQL
 * na serveru databáze; popisky v UI to musí říct nahlas (viz lib/time.ts).
 *
 * Soubor je ZÁMĚRNĚ bez importů a bez `@/` aliasů — testuje se přímo přes
 * `tsx --test`, který alias neumí rozřešit.
 */

/** Časové pásmo, ve kterém se člověku ukazují VŠECHNY časy. */
export const APP_TIME_ZONE = "Europe/Prague";

const LOCALE = "cs-CZ";

/** Nejmenší částka, kterou má smysl zobrazit na dvě desetinná místa. */
const NEJMENSI_ZOBRAZITELNA = 0.005;

function cislo(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function datum(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Peníze v cs-CZ, tedy „0,60 US$" (ne „$0.60").
 *
 *   'amount'  — běžná útrata, 2 desetinná místa. Nenulová částka menší než
 *               půl centu se zobrazí jako „< 0,01 US$": zaokrouhlené „0,00 US$"
 *               u reálné útraty lže, protože tvrdí, že se neutratilo nic.
 *   'precise' — pevně 4 místa (tooltipy grafů, jednotlivé pohyby).
 *   'cap'     — pevně 2 místa (stropy; strop je vždy „kulatá" částka).
 */
export function formatUsd(
  value: number | null | undefined,
  mode: "amount" | "precise" | "cap" = "amount",
): string {
  const n = cislo(value);
  const mist = mode === "precise" ? 4 : 2;
  if (mode === "amount" && n !== 0 && Math.abs(n) < NEJMENSI_ZOBRAZITELNA) {
    const mez = mena(0.01, 2);
    return n > 0 ? `< ${mez}` : `> −${mez}`;
  }
  return mena(n, mist);
}

function mena(n: number, mist: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: mist,
    maximumFractionDigits: mist,
  }).format(n);
}

/** Osa grafu: jen číslo, bez měny (jednotka patří do popisku osy). */
export function formatUsdAxis(value: number | null | undefined): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cislo(value));
}

/** Poměr 0..1 jako „20 %" (v češtině s mezerou před procentem). */
export function formatPercent(ratio: number | null | undefined, desetinna = 0): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    minimumFractionDigits: desetinna,
    maximumFractionDigits: desetinna,
  }).format(cislo(ratio));
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat(LOCALE).format(cislo(value));
}

/** Velikost souboru, nejvýš jedno desetinné místo („1,5 MB"). */
export function formatBytes(bytes: number | null | undefined): string {
  const n = cislo(bytes);
  if (n <= 0) return "—";
  const jednotky = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < jednotky.length - 1) {
    v /= 1024;
    i += 1;
  }
  const cis = new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(v);
  return `${cis} ${jednotky[i]}`;
}

/**
 * Doba trvání: „45 s", „1 min 5 s", „1 h 5 min".
 * Dřív to vracelo „1:05", což se u minut četlo jako hodiny.
 */
export function formatDuration(seconds: number | null | undefined): string {
  const celkem = Math.round(cislo(seconds));
  if (celkem <= 0) return "—";
  if (celkem < 60) return `${celkem} s`;
  if (celkem < 3600) {
    const m = Math.floor(celkem / 60);
    const s = celkem % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(celkem / 3600);
  const m = Math.floor((celkem % 3600) / 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Datum a čas v Europe/Prague („15. 9. 2026 18:52"). */
export function formatDate(value: string | Date | null | undefined): string {
  const d = datum(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(d);
}

/** Jen den a měsíc v Europe/Prague („14. 9."). */
export function formatDateShort(value: string | Date | null | undefined): string {
  const d = datum(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "numeric",
    timeZone: APP_TIME_ZONE,
  }).format(d);
}

/**
 * Popisek dne na ose grafu („14. 9."). Bere i klíč „2026-09-14" z `lastUtcDays`,
 * který se parsuje jako půlnoc UTC — v Praze pořád tentýž den.
 */
export function formatDayShort(value: string | Date | null | undefined): string {
  return formatDateShort(value);
}

/** Jen čas v Europe/Prague („06:00") — pro popisky oken. */
export function formatTimeShort(value: string | Date | null | undefined): string {
  const d = datum(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: APP_TIME_ZONE,
  }).format(d);
}

const RELATIVNI = new Intl.RelativeTimeFormat("cs", { numeric: "auto" });

/**
 * „právě teď", „včera", „před 3 týdny". Nad 30 dní už relativní údaj nic neříká,
 * takže se vrátí absolutní datum.
 *
 * `now` je parametr, ne `Date.now()` uvnitř — jinak by funkce nešla otestovat.
 */
export function formatRelative(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const d = datum(value);
  if (!d) return "—";
  const rozdilS = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(rozdilS);

  if (abs < 5) return "právě teď";
  if (abs < 45) return RELATIVNI.format(Math.round(rozdilS), "second");
  if (abs < 45 * 60) return RELATIVNI.format(Math.round(rozdilS / 60), "minute");
  if (abs < 22 * 3600) return RELATIVNI.format(Math.round(rozdilS / 3600), "hour");
  if (abs < 7 * 86400) return RELATIVNI.format(Math.round(rozdilS / 86400), "day");
  if (abs <= 30 * 86400) return RELATIVNI.format(Math.round(rozdilS / (7 * 86400)), "week");
  return formatDate(d);
}

/** Poměr útraty ke stropu (0..1, oříznuto). Strop 0 nebo záporný = nic neblokuje. */
export function spendRatio(spent: number, cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const s = Number.isFinite(spent) ? spent : 0;
  return Math.min(1, Math.max(0, s / cap));
}
