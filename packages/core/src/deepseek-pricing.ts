/**
 * CENÍK DEEPSEEKU A PÁSMA ŠPIČKY — jediné místo pravdy pro TypeScript.
 *
 * Zrcadlo `infra/litellm/farm_budget_guard.py` (Python ↔ TS). Když se změní ceny,
 * MODEL_ALIASES nebo okna špičky v hlídači, uprav i tohle — a naopak.
 *
 * Zdroj cen: https://api-docs.deepseek.com/quick_start/pricing (ověřeno 2026-09-16)
 *   „Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 *    06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 *
 * Proč to vůbec existuje: DeepSeek účtuje mimo špičku polovinu, ale LiteLLM umí
 * jen jednu cenu na model. Hlídač i orchestrátor proto počítají pásmo sami z času
 * a KONZERVATIVNĚ: cena mimo špičku platí jen tehdy, když celý požadavek (od přijetí
 * po vyúčtování, rozšířený o rezervu na rozjezd hodin) leží mimo špičková okna.
 * Cokoli nejistého se počítá jako špička — nikdy se nesmí započítat míň, než
 * DeepSeek skutečně naúčtuje.
 */

/** Cenové pásmo. `peak` = drahé hodiny, `offpeak` = poloviční ceny. */
export type PriceTier = "peak" | "offpeak";

/** Modely, které farma smí volat (klíče ceníku, ne ID poskytovatele). */
export type DeepseekModel = "deepseek-flash" | "deepseek-v4-pro";

export interface DeepseekPrice {
  /** US$ za 1M vstupních tokenů mimo cache. */
  inputUsdPerM: number;
  /** US$ za 1M výstupních tokenů. */
  outputUsdPerM: number;
  /** US$ za 1M vstupních tokenů potvrzených jako zásah cache. */
  cachedInputUsdPerM: number;
}

/** Ceny obou pásem. Mimo špičku je přesně polovina špičky (hlídá test). */
export const DEEPSEEK_PRICES: Record<PriceTier, Record<DeepseekModel, DeepseekPrice>> = {
  peak: {
    "deepseek-flash": { inputUsdPerM: 0.3, outputUsdPerM: 1.2, cachedInputUsdPerM: 0.006 },
    "deepseek-v4-pro": { inputUsdPerM: 1.32, outputUsdPerM: 3.96, cachedInputUsdPerM: 0.044 },
  },
  offpeak: {
    "deepseek-flash": { inputUsdPerM: 0.15, outputUsdPerM: 0.6, cachedInputUsdPerM: 0.003 },
    "deepseek-v4-pro": { inputUsdPerM: 0.66, outputUsdPerM: 1.98, cachedInputUsdPerM: 0.022 },
  },
};

/**
 * Alias okruhu → model. MUSÍ odpovídat MODEL_ALIASES v hlídači i `model` v
 * infra/litellm/config.yaml. Běžná vývojářská práce (worker) a krátká systémová
 * volání (cheap) jedou na Flash; plánování, hodnocení a eskalace po selhání na Pro.
 */
export const DEEPSEEK_MODEL_BY_ALIAS: Record<string, DeepseekModel> = {
  manager: "deepseek-v4-pro",
  worker: "deepseek-flash",
  "worker-hard": "deepseek-v4-pro",
  "worker-fallback": "deepseek-v4-pro",
  judge: "deepseek-v4-pro",
  cheap: "deepseek-flash",
  "media-vlm": "deepseek-v4-pro",
};

/** Okna špičky v UTC, půlotevřená [od, do), jen pondělí–pátek. */
export const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** Strop výstupu jednoho požadavku (MAX_OUTPUT_TOKENS v hlídači). */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 4096;
/** Obálka požadavku, kterou hlídač připočítá ke kontextu (bajty). */
export const DEEPSEEK_REQUEST_ENVELOPE_BYTES = 512;
/** Rezerva na rozjezd hodin mezi námi, DB a poskytovatelem (s). */
export const DEEPSEEK_CLOCK_DRIFT_SEC = 120;
/** Nejdelší možná doba běhu jednoho požadavku (s) — viz MAX_REQUEST_SECONDS v hlídači. */
export const DEEPSEEK_MAX_REQUEST_SEC = 1200;

/** Je v daném okamžiku špička? Okna jsou celé UTC hodiny a platí jen v pracovní dny. */
export function isDeepseekPeakUtc(moment: Date): boolean {
  const day = moment.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = moment.getUTCHours();
  return DEEPSEEK_PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/**
 * Zasahuje interval [start, end] do špičky? Hranice oken i den v týdnu jsou uvnitř
 * jedné UTC hodiny konstantní, takže stačí projít každou dotčenou hodinu. Nesmyslný
 * vstup (obrácené hodiny, interval delší než týden) je špička.
 */
export function deepseekPeakOverlaps(start: Date, end: Date): boolean {
  const from = start.getTime();
  const to = end.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  if (to < from || to - from > 7 * 24 * 3600_000) return true;
  const hour = new Date(from);
  hour.setUTCMinutes(0, 0, 0);
  for (let t = hour.getTime(); t <= to; t += 3600_000) {
    if (isDeepseekPeakUtc(new Date(t))) return true;
  }
  return false;
}

/**
 * Pásmo celého požadavku. Mimo špičku JEN tehdy, když ani interval rozšířený
 * o `marginSec` na obě strany nezasahuje do špičky. Jinak špička.
 */
export function deepseekPriceTier(
  start: Date,
  end: Date,
  marginSec: number = DEEPSEEK_CLOCK_DRIFT_SEC,
): PriceTier {
  const margin = Math.max(0, marginSec) * 1000;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "peak";
  return deepseekPeakOverlaps(new Date(start.getTime() - margin), new Date(end.getTime() + margin))
    ? "peak"
    : "offpeak";
}

/**
 * Pásmo pro REZERVACI: požadavek přijatý teď může běžet až `maxSeconds`. Když by
 * v nejhorším případě zasáhl do špičky, rezervuje se špičkovou cenou.
 */
export function deepseekReservationTier(
  admitted: Date,
  maxSeconds: number = DEEPSEEK_MAX_REQUEST_SEC,
): PriceTier {
  return deepseekPriceTier(admitted, new Date(admitted.getTime() + Math.max(0, maxSeconds) * 1000));
}

/** „deepseek/deepseek-v4.1-flash" → „deepseek-flash". Neznámý model → null. */
export function normalizeDeepseekModel(model: string | null | undefined): DeepseekModel | null {
  if (typeof model !== "string") return null;
  const bare = model.startsWith("deepseek/") ? model.slice("deepseek/".length) : model;
  if (bare === "deepseek-v4-flash" || bare === "deepseek-v4.1-flash" || bare === "deepseek-flash") {
    return "deepseek-flash";
  }
  return bare === "deepseek-v4-pro" ? "deepseek-v4-pro" : null;
}

/**
 * Cena jednoho dokončeného požadavku. `cachedTokens` se odečte ze vstupu a účtuje
 * se sazbou cache; nesmyslný počet zásahů cache slevu NEDOSTANE (stejně jako hlídač).
 */
export function deepseekChargeUsd(input: {
  model: DeepseekModel;
  tokensIn: number;
  tokensOut: number;
  cachedTokens?: number;
  tier: PriceTier;
}): number {
  const price = DEEPSEEK_PRICES[input.tier === "offpeak" ? "offpeak" : "peak"][input.model];
  const tokensIn = Math.max(0, input.tokensIn);
  const tokensOut = Math.max(0, input.tokensOut);
  const cachedRaw = input.cachedTokens ?? 0;
  const cached = Number.isFinite(cachedRaw) && cachedRaw >= 0 && cachedRaw <= tokensIn ? cachedRaw : 0;
  return (
    ((tokensIn - cached) * price.inputUsdPerM +
      cached * price.cachedInputUsdPerM +
      tokensOut * price.outputUsdPerM) /
    1_000_000
  );
}

/**
 * Cena jednoho spend-logu LiteLLM přepočtená podle SKUTEČNÉHO ceníku DeepSeeku.
 *
 * LiteLLM umí jen jednu cenu na model, takže jeho vlastní `spend` je v cenách mimo
 * špičku. Pro cost_ledger (a tím i pro stropy projektu, uživatele a přání) chceme
 * cenu podle času požadavku: pásmo se určí ze stejné konzervativní obálky jako
 * v hlídači, nad intervalem [začátek, konec] řádku.
 *
 * Když model neznáme nebo by přepočet vyšel nulový u řádku, který něco stál
 * (chybějící tokeny v logu), platí číslo z LiteLLM — ale ve ŠPIČCE zdvojnásobené.
 * `model_info` v config.yaml totiž nese mimošpičkové ceny, takže číslo z LiteLLM je
 * samo o sobě v poloviční sazbě; bez zdvojnásobení by tahle „záloha" u požadavku ze
 * špičky útratu podhodnotila na polovinu — a cost_ledger drží stropy projektu,
 * uživatele i přání. Přes tenhle proxy jdou jen routy DeepSeeku, takže neznámý model
 * v novém spend-logu znamená změnu routování, jejíž cenu neznáme: konzervativní
 * horní odhad je tam správně (stejně jako u nejistého požadavku v hlídači).
 */
export function repricedSpendUsd(input: {
  model: string | null | undefined;
  tokensIn: number;
  tokensOut: number;
  cachedTokens?: number;
  start: Date;
  end: Date;
  litellmSpendUsd: number;
}): number {
  const tier = deepseekPriceTier(input.start, input.end);
  const zLitellm = tier === "peak" ? input.litellmSpendUsd * 2 : input.litellmSpendUsd;
  const model = normalizeDeepseekModel(input.model);
  if (model === null) return zLitellm;
  const usd = deepseekChargeUsd({
    model,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    cachedTokens: input.cachedTokens ?? 0,
    tier,
  });
  return usd > 0 ? usd : zLitellm;
}

/**
 * Horní odhad rezervace hlídače pro jeden požadavek s daným kontextem — stejný
 * vzorec jako `estimate()` v hlídači (bajty + obálka, výstup na stropu, bez cache).
 */
export function deepseekReservationUsd(input: {
  contextBytes: number;
  model: DeepseekModel;
  tier: PriceTier;
}): number {
  const bytes = Number.isFinite(input.contextBytes) && input.contextBytes >= 0 ? input.contextBytes : 0;
  return deepseekChargeUsd({
    model: input.model,
    tokensIn: bytes + DEEPSEEK_REQUEST_ENVELOPE_BYTES,
    tokensOut: DEEPSEEK_MAX_OUTPUT_TOKENS,
    tier: input.tier,
  });
}
