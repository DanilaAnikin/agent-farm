/**
 * Rozpočtový widget hlavičky — ČISTÝ výpočet toho, co se má ukázat.
 *
 * Dřív hlavička ukazovala dvě nesouvisející čísla: „Dnešní útrata X / 15,00 US$"
 * (mrtvý sloupec profiles.daily_cap_usd) a „Farma dnes strop 5,00 US$" (env
 * dashboardu). Skutečně platí strop farmy z `farm_settings` (0,60 / 20 US$)
 * a o práci rozhoduje rozpočtový hlídač LiteLLM, který počítá i rezervace.
 *
 * Pravidla, která tady platí:
 *   - admin vidí čísla hlídače (`*_counted`, nikdy menší než náš ledger)
 *     a „z toho rezervováno",
 *   - člen vidí jen součet vlastních pohybů a UI to tak nazve,
 *   - `ready: null` = hlídač neodpovídá. Pak se ukážou jen pohyby a widget to
 *     řekne nahlas — nula z nedostupného hlídače NENÍ pravda.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import type { BudgetSnapshot, CostSummaryRow } from "./rpc";
import { formatTimeShort, formatUsd, spendRatio } from "./format";
import { startOfUtcDayIso, startOfUtcMonthIso } from "./time";

export type BudgetSource = "guard" | "ledger";

export interface LedgerSpend {
  /** Dnešní útrata z pohybů (UTC den); `null` = nepodařilo se přečíst. */
  day: number | null;
  /** Útrata od začátku UTC měsíce; `null` = nepodařilo se přečíst. */
  month: number | null;
}

export interface BudgetWidgetInput {
  isAdmin: boolean;
  /** Výsledek `farm_budget_snapshot()`; pro člena nebo při chybě `null`. */
  snapshot: BudgetSnapshot | null;
  ledger: LedgerSpend;
  caps: { dailyUsd: number; monthlyUsd: number };
  now?: Date;
}

export interface BudgetWidget {
  source: BudgetSource;
  day: number | null;
  month: number | null;
  reserved: number | null;
  dayCap: number;
  monthCap: number;
  /** Poměr limitu, který je blíž vyčerpání (0..1). */
  ratio: number;
  nearer: "day" | "month";
  /** „0,00 / 0,60 US$" */
  dayText: string;
  /** „5,49 / 20,00 US$" */
  monthText: string;
  /** Kompaktní tvar na mobil: „0,00/0,60 US$" (limit blíž vyčerpání). */
  compactText: string;
  /** Ke kterému limitu kompaktní tvar patří. */
  compactLabel: "dnes" | "měsíc";
  /** „z toho rezervováno 0,12 US$" nebo null. */
  reservedText: string | null;
  /** Krátký popis původu čísel. */
  sourceLabel: string;
  /** Tooltip s původem a koncem UTC dne v pražském čase. */
  title: string;
  /** Celá věta pro čtečky. */
  ariaLabel: string;
  /** Varování, když čísla nejsou autoritativní (hlídač neodpovídá…). */
  warning: string | null;
}

/**
 * Sečte řádky `cost_summary(p_since = začátek UTC měsíce)` na dnešek a měsíc.
 * `day` je v RPC typ `date` („2026-09-15"), porovnává se s UTC dnem.
 */
export function sumCostSummary(
  rows: Pick<CostSummaryRow, "day" | "cost_usd">[],
  now: Date = new Date(),
): { day: number; month: number } {
  const dnes = startOfUtcDayIso(now).slice(0, 10);
  let day = 0;
  let month = 0;
  for (const r of rows) {
    const castka = typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd) ? r.cost_usd : Number(r.cost_usd) || 0;
    month += castka;
    if (String(r.day).slice(0, 10) === dnes) day += castka;
  }
  return { day, month };
}

/** Minimální tvar klienta, který umí zavolat RPC (serverový i prohlížečový Supabase). */
interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Útrata z pohybů přes `cost_summary` (RLS platí, obchází limit 1000 řádků).
 * Chyba = `null`, ne 0 — widget pak napíše, že se útrata nenačetla.
 */
export async function fetchLedgerSpend(client: RpcClient, now: Date = new Date()): Promise<LedgerSpend> {
  const { data, error } = await client.rpc("cost_summary", { p_since: startOfUtcMonthIso(now) });
  if (error || !Array.isArray(data)) return { day: null, month: null };
  return sumCostSummary(data as Pick<CostSummaryRow, "day" | "cost_usd">[], now);
}

/** Konec aktuálního UTC dne (= kdy se denní strop přetočí). */
export function endOfUtcDay(now: Date = new Date()): Date {
  return new Date(new Date(startOfUtcDayIso(now)).getTime() + 24 * 3600 * 1000);
}

/** Částka bez měny („0,60"), aby šlo psát „0,00 / 0,60 US$". Intl zůstává ve format.ts. */
function bezMeny(text: string): string {
  return text.replace(/\s*US\$$/u, "");
}

function castka(value: number | null): string {
  return value === null ? "—" : bezMeny(formatUsd(value, "amount"));
}

function dvojice(value: number | null, cap: number, oddelovac: string): string {
  return `${castka(value)}${oddelovac}${formatUsd(cap, "cap")}`;
}

function cisloNeboNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Větší ze dvou známých čísel; neznámé se ignoruje, obě neznámé = null. */
function vetsi(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export function budgetWidget(input: BudgetWidgetInput): BudgetWidget {
  const now = input.now ?? new Date();
  const dayCap = input.caps.dailyUsd;
  const monthCap = input.caps.monthlyUsd;
  const snap = input.isAdmin && input.snapshot?.admin ? input.snapshot : null;
  const hlidacOdpovida = snap !== null && snap.ready !== null;

  let source: BudgetSource;
  let day: number | null;
  let month: number | null;
  let reserved: number | null = null;
  let warning: string | null = null;

  if (snap && hlidacOdpovida) {
    // Orchestrátor i brána rozhodují podle max(ledger, hlídač) — ukazujeme totéž.
    source = "guard";
    day = vetsi(cisloNeboNull(snap.day_counted), cisloNeboNull(snap.day_settled));
    month = vetsi(cisloNeboNull(snap.month_counted), cisloNeboNull(snap.month_settled));
    reserved = cisloNeboNull(snap.day_reserved);
  } else if (snap) {
    source = "ledger";
    day = vetsi(cisloNeboNull(snap.day_settled), input.ledger.day);
    month = vetsi(cisloNeboNull(snap.month_settled), input.ledger.month);
    warning = "Rozpočtový hlídač neodpovídá — čísla jsou jen z pohybů, rezervace v nich chybí.";
  } else {
    source = "ledger";
    day = input.ledger.day;
    month = input.ledger.month;
    if (input.isAdmin) {
      warning = "Přehled rozpočtového hlídače se nepodařilo načíst — čísla jsou jen z pohybů.";
    }
  }

  if (day === null && month === null && warning === null) {
    warning = "Útratu se nepodařilo načíst.";
  }

  const dayRatio = day === null ? 0 : spendRatio(day, dayCap);
  const monthRatio = month === null ? 0 : spendRatio(month, monthCap);
  const nearer = monthRatio > dayRatio ? "month" : "day";
  const ratio = Math.max(dayRatio, monthRatio);

  const sourceLabel = source === "guard" ? "rozpočtový hlídač" : "započteno z pohybů";
  const konecDne = formatTimeShort(endOfUtcDay(now));
  const dayText = dvojice(day, dayCap, " / ");
  const monthText = dvojice(month, monthCap, " / ");
  const reservedText =
    reserved !== null && reserved > 0 ? `z toho rezervováno ${formatUsd(reserved, "amount")}` : null;

  const title = [
    `Zdroj: ${sourceLabel} · den končí ve ${konecDne} (Europe/Prague)`,
    reservedText,
    warning,
  ]
    .filter(Boolean)
    .join("\n");

  const ariaLabel = [
    `Útrata farmy dnes ${day === null ? "neznámá" : formatUsd(day, "amount")} z ${formatUsd(dayCap, "cap")}`,
    `za měsíc ${month === null ? "neznámá" : formatUsd(month, "amount")} z ${formatUsd(monthCap, "cap")}`,
    reservedText,
    `zdroj: ${sourceLabel}`,
    warning,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    source,
    day,
    month,
    reserved,
    dayCap,
    monthCap,
    ratio,
    nearer,
    dayText,
    monthText,
    compactText: nearer === "month" ? dvojice(month, monthCap, "/") : dvojice(day, dayCap, "/"),
    compactLabel: nearer === "month" ? "měsíc" : "dnes",
    reservedText,
    sourceLabel,
    title,
    ariaLabel,
    warning,
  };
}
