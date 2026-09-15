/**
 * ROZPOČTOVÉ ODKLADY POKUSŮ — čistá logika bez DB a bez sítě.
 *
 * Dřív každá rozpočtová chyba pokusu (402) vedla na totéž: checkpoint, zpět do
 * fronty za hodinu, bez limitu. Pod jednou chybou se ale schovávají dvě různé věci:
 *
 *  (a) `attempt_allowance` — vyčerpaný per-pokus klíč LiteLLM (max_budget =
 *      PER_ATTEMPT_BUDGET_USD). Znamená „úkol je na jeden pokus moc velký".
 *      Čekání nepomůže; pomůže jen pokrok z checkpointu, nebo menší úkol.
 *  (b) rozpočtový hlídač farmy (infra/litellm/farm_budget_guard.py):
 *      `farm_window` — „budget: daily/monthly limit reached": skutečné čekání na
 *      reset UTC okna; `farm_blocked` — „farm is paused" / „accounting is not
 *      ready" / „accounting unavailable": farma teď nesmí utrácet vůbec.
 *
 * V produkci (15. 9. 2026) se to smíchalo: dva úkoly celý den každou hodinu pálily
 * 0,05–0,07 US$ na pokus a checkpoint SHA se ani jednou nezměnil.
 */
import { checkBudget, nextResetUtc } from "@farm/core";
import type { CapSet, SpendSnapshot } from "@farm/core";

export type BudgetDeferralKind = "attempt_allowance" | "farm_window" | "farm_blocked";
export type BudgetWindow = "daily" | "monthly";

export interface BudgetDeferralClass {
  kind: BudgetDeferralKind;
  /** Jen u `farm_window`: které okno se musí resetovat. */
  window?: BudgetWindow;
  /** false = text chyby jsme nepoznali a zařadili ho konzervativně (viz níž). */
  recognized: boolean;
}

// Texty hlídače jsou konstanty v našem kódu (reject("…") ve farm_budget_guard.py)
// a hlídač je výslovně drží stabilní. Předpona „budget: " je volitelná, kdyby ji
// LiteLLM při balení HTTPException do JSON chyby odřízl.
const FARM_WINDOW_RE = /(?:budget:\s*)?\b(daily|monthly) limit reached\b/i;
const FARM_BLOCKED_RE = /(?:budget:\s*)?\b(farm is paused|accounting is not ready|accounting is unavailable|accounting unavailable)\b/i;
// Per-pokus klíč: LiteLLM BudgetExceededError („Budget has been exceeded! Current
// cost: …, Max budget: …", typ `budget_exceeded`) a starší varianty ExceededKeyBudget /
// ExceededTokenBudget. Tyhle texty jsou verzí LiteLLM, ne naše — proto širší sada.
const ATTEMPT_ALLOWANCE_RE = /budget has been exceeded|max[ _]budget|exceeded(?:key|token)?budget|over budget|budget_exceeded/i;

/**
 * Rozliší druh rozpočtové chyby z textu (hláška/tělo odpovědi). `null`, když text
 * nenese žádný známý rozpočtový vzor. Pořadí je důležité: texty hlídače jsou
 * nejkonkrétnější, proto se testují první.
 */
export function classifyBudgetText(text: string): BudgetDeferralClass | null {
  const window = FARM_WINDOW_RE.exec(text);
  if (window) {
    return { kind: "farm_window", window: window[1]!.toLowerCase() as BudgetWindow, recognized: true };
  }
  if (FARM_BLOCKED_RE.test(text)) return { kind: "farm_blocked", recognized: true };
  if (ATTEMPT_ALLOWANCE_RE.test(text)) return { kind: "attempt_allowance", recognized: true };
  return null;
}

/**
 * Neznámý 402 se řadí jako `attempt_allowance` (recognized=false). Proč právě tak:
 *  - Texty hlídače (b) jsou naše konstanty, takže nepoznaný text skoro jistě
 *    pochází z LiteLLM, tedy z per-pokus klíče (a).
 *  - Cesta (a) je jediná OMEZENÁ: po MAX_STALLED_ALLOWANCE_DEFERRALS odkladech bez
 *    pokroku úkol zaparkuje. `farm_blocked` by se opakoval bez limitu a
 *    `farm_window` by pro chybu, která s oknem nesouvisí, odkládal denně navždy.
 *  - Omyl opačným směrem (skutečný strop farmy vyložený jako příděl) stojí nejvýš
 *    zaparkovaný úkol, který farma sama přeplánuje — žádné peníze navíc.
 * Výjimku (402 hned na prvním požadavku) řeší refineBudgetClass.
 */
export const UNRECOGNIZED_BUDGET_CLASS: BudgetDeferralClass = Object.freeze({
  kind: "attempt_allowance",
  recognized: false,
});

/**
 * Upřesnění podle průběhu pokusu. Nepoznaný 402, když pokus nestihl ani jeden krok,
 * příděl pokusu vyčerpat nemohl: per-pokus klíč se vyčerpá až útratou a LiteLLM
 * kontroluje jeho rozpočet před požadavkem. Typicky jde o poskytovatele (DeepSeek
 * hlásí „Insufficient Balance" jako 402 a LiteLLM status propouští). Takový odklad
 * se vede jako `farm_blocked`: hodinové čekání, které nic nestojí a úkol
 * nezaparkuje. Bez toho by několikahodinový výpadek kreditu u poskytovatele
 * zaparkoval úkoly jako „moc velké" a přes přeplánování nevratně odložil přání.
 * Nepoznaný 402 až po nějakých krocích zůstává `attempt_allowance` — pokus utrácel
 * a jen tahle cesta má limit.
 */
export function refineBudgetClass(budget: BudgetDeferralClass, steps: number): BudgetDeferralClass {
  if (budget.recognized || budget.kind !== "attempt_allowance") return budget;
  return steps > 0 ? budget : { kind: "farm_blocked", recognized: false };
}

function isBudgetClass(value: unknown): value is BudgetDeferralClass {
  const v = value as Partial<BudgetDeferralClass> | null;
  return (
    v !== null &&
    typeof v === "object" &&
    (v.kind === "attempt_allowance" || v.kind === "farm_window" || v.kind === "farm_blocked") &&
    typeof v.recognized === "boolean"
  );
}

/**
 * Klasifikace chyby, která už prošla isLlmBudgetError. OpencodePromptError nese
 * druh v `budget` (tělo odpovědi schválně nekopíruje — může obsahovat tajemství);
 * LlmError z chat klienta má tělo v `body`.
 */
export function classifyBudgetDeferral(error: unknown): BudgetDeferralClass {
  const carried = (error as { budget?: unknown } | null)?.budget;
  if (isBudgetClass(carried)) return carried;
  const value = error as { message?: unknown; body?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error);
  const body = typeof value?.body === "string" ? value.body : "";
  return classifyBudgetText(`${message} ${body}`) ?? UNRECOGNIZED_BUDGET_CLASS;
}

/** Krátký, bezpečný popisek do hlášky/output_summary (žádná data z odpovědi). */
export function budgetClassLabel(budget: BudgetDeferralClass): string {
  if (!budget.recognized) return "unrecognized";
  return budget.window ? `${budget.kind}:${budget.window}` : budget.kind;
}

// --- farm_window: odklad do resetu okna ------------------------------------------

/**
 * Rezerva po resetu. Hlídač i orchestrátor měří okno v UTC (date_trunc), ale
 * hodiny DB a orchestrátoru se můžou o chvilku lišit — zpráva, která se ukáže
 * vteřinu před resetem, by jen zbytečně spustila placený pokus do zavřeného okna.
 */
export const BUDGET_RESET_MARGIN_SEC = 120;

/** Okamžik resetu rozpočtového okna (UTC): další půlnoc, resp. první den dalšího měsíce. */
export function budgetWindowResetAt(window: BudgetWindow, now: Date): Date {
  if (window === "monthly") {
    // Date.UTC přetečení měsíce řeší samo (prosinec → leden dalšího roku).
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return nextResetUtc(now);
}

/** Za kolik sekund smí úkol znovu do fronty (pgmq delay), aby nešel do zavřeného okna. */
export function secondsUntilBudgetReset(
  window: BudgetWindow,
  now: Date,
  marginSec: number = BUDGET_RESET_MARGIN_SEC,
): number {
  const ms = budgetWindowResetAt(window, now).getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 1000)) + Math.max(0, Math.trunc(marginSec));
}

/** Pauza mezi pokusy u přídělu a u zablokovaného hlídače (beze změny proti dřívějšku). */
export const BUDGET_DEFERRAL_DELAY_SEC = 3600;

/** Kolik krátkých odkladů při odmítnutí, které data orchestrátoru nepotvrdila, smí úkol mít v jednom okně. */
export const MAX_TRANSIENT_WINDOW_DEFERRALS = Number(process.env.MAX_TRANSIENT_WINDOW_DEFERRALS ?? 2);

export type FarmScope = "farm" | "farm_month";

/**
 * Odklad po „budget: daily/monthly limit reached".
 *
 * Hlídač do útraty okna počítá i REZERVACE souběžných, ještě nevyúčtovaných
 * požadavků (farm_budget_totals: settled → actual_usd, jinak reserved_usd). Judge,
 * manager, tester i druhý worker běží souběžně, rezervace workera je až ~0,20 US$
 * a skutečná cena bývá ~0,003 — odmítnutí tak může být jen přechodné. Proto
 * rozhoduje `farmScope` = vstupní brána nad útratou orchestrátoru (farmGuardScope):
 *  - "farm_month" / "farm": okno je zavřené i podle našich dat → do resetu toho okna;
 *  - "unknown" (data nešla načíst): do resetu okna z hlášky — čekání nic nestojí;
 *  - null: přechodné odmítnutí → krátký odklad (nejvýš do resetu); po
 *    MAX_TRANSIENT_WINDOW_DEFERRALS takových odkladech v témže okně už do resetu,
 *    ať přechodná odmítnutí netočí placené pokusy.
 */
export function decideFarmWindowDelay(
  input: { window: BudgetWindow; now: Date; farmScope: FarmScope | null | "unknown"; priorTransient: number },
  shortDelaySec: number = BUDGET_DEFERRAL_DELAY_SEC,
  maxTransient: number = MAX_TRANSIENT_WINDOW_DEFERRALS,
): { delaySec: number; window: BudgetWindow; transient: boolean } {
  const untilReset = (window: BudgetWindow) => ({
    delaySec: secondsUntilBudgetReset(window, input.now),
    window,
    transient: false,
  });
  if (input.farmScope === "farm_month") return untilReset("monthly");
  if (input.farmScope === "farm") return untilReset("daily");
  if (input.farmScope === "unknown" || !(input.priorTransient < maxTransient)) return untilReset(input.window);
  const short = Math.max(1, Math.trunc(shortDelaySec));
  return { delaySec: Math.min(short, secondsUntilBudgetReset(input.window, input.now)), window: input.window, transient: true };
}

// --- attempt_allowance: odklady bez pokroku ---------------------------------------

/** Kolik po sobě jdoucích odkladů bez nového commitu úkol smí mít, než se zaparkuje. */
export const MAX_STALLED_ALLOWANCE_DEFERRALS = Number(process.env.MAX_STALLED_ALLOWANCE_DEFERRALS ?? 2);
/**
 * Pojistka nad rámec „bez pokroku": úkol, který příděl vyčerpal tolikrát celkem,
 * je na jeden pokus zjevně moc velký, i když pokaždé něco commitne (6 × 0,15 US$
 * je víc než denní strop projektu). Bez ní by „pokrok" typu přepisování téhož
 * souboru točil úkol donekonečna.
 */
export const MAX_ALLOWANCE_DEFERRALS_TOTAL = Number(process.env.MAX_ALLOWANCE_DEFERRALS_TOTAL ?? 6);

/** Tvar `events.data` u `attempt_budget_deferred` (starší události mají jen attemptId+resumeRef). */
export interface PriorBudgetDeferral {
  resumeRef?: unknown;
  kind?: unknown;
  progressed?: unknown;
}

/**
 * Udělal pokus pokrok? Ano, když orchestrátor po něm commitnul nové změny, nebo
 * když checkpoint skončil jinde, než pokus začal. Worker sám commitovat neumí
 * (worktree .git není v kontejneru), takže `committed` je spolehlivý signál.
 */
export function attemptProgressed(input: {
  committed: boolean;
  resumeRef: string;
  startRef?: string | null;
}): boolean {
  return input.committed || (typeof input.startRef === "string" && input.startRef !== input.resumeRef);
}

function countsAsAllowance(ev: PriorBudgetDeferral): boolean {
  // Události bez `kind` jsou z doby před klasifikací — tehdy se vše odkládalo
  // stejně, takže se počítají (konzervativně, jde o jednorázový přechod).
  return ev.kind === undefined || ev.kind === null || ev.kind === "attempt_allowance";
}

export type AllowanceDecision =
  | { action: "defer"; stalled: number }
  | { action: "park"; stalled: number; reason: "stalled" | "total" };

/**
 * Kolik placených pokusů z téhož checkpointu ještě zbývá po odkladu se `stalled`
 * konci bez pokroku. Při stalled = 1 jsou to dva: další konec bez pokroku se ještě
 * odloží, až ten po něm úkol zaparkuje.
 */
export function remainingStalledAttempts(stalled: number, maxStalled: number = MAX_STALLED_ALLOWANCE_DEFERRALS): number {
  return Math.max(0, maxStalled + 1 - stalled);
}

/**
 * Rozhodne, jestli se úkol po vyčerpaném přídělu pokusu smí znovu odložit.
 *
 * `prior` = dřívější `attempt_budget_deferred` téhož úkolu, NEJNOVĚJŠÍ PRVNÍ.
 * `totalPrior` = počet přídělových odkladů od posledního resetu životního cyklu
 * (ruční retry, oprava před sloučením) bez limitu okna; bez něj se spočítá z `prior`.
 * `stalled` ve výsledku = počet odkladů bez pokroku na stejném checkpointu
 * včetně toho aktuálního.
 *
 * Řada „bez pokroku" se počítá od nejnovějšího odkladu dozadu, dokud:
 *  - odklad nese stejný checkpoint (jiný SHA = mezitím vznikl commit → konec řady),
 *  - odklad sám nebyl pokrokem (u starých událostí bez `progressed` se to odvodí
 *    z toho, že předchozí odklad nesl stejný SHA; nejstarší známý ho vytvořil).
 * Odklady kvůli oknu farmy na stejném checkpointu se nepočítají, ale ani řadu
 * nepřeruší — za to, že farma zavřela okno, úkol nemůže.
 */
export function decideAllowanceDeferral(
  input: {
    committed: boolean;
    resumeRef: string;
    startRef?: string | null;
    prior: readonly PriorBudgetDeferral[];
    totalPrior?: number;
  },
  maxStalled: number = MAX_STALLED_ALLOWANCE_DEFERRALS,
  maxTotal: number = MAX_ALLOWANCE_DEFERRALS_TOTAL,
): AllowanceDecision {
  const prior = input.prior;
  const totalAllowance =
    typeof input.totalPrior === "number" && Number.isFinite(input.totalPrior)
      ? input.totalPrior
      : prior.filter(countsAsAllowance).length;
  const progressed = attemptProgressed(input);

  let streak = 0;
  if (!progressed) {
    for (let i = 0; i < prior.length; i++) {
      const ev = prior[i]!;
      if (typeof ev.resumeRef !== "string" || ev.resumeRef !== input.resumeRef) break;
      const stalled =
        typeof ev.progressed === "boolean" ? !ev.progressed : prior[i + 1]?.resumeRef === ev.resumeRef;
      if (!stalled) break;
      if (countsAsAllowance(ev)) streak++;
    }
  }
  const stalled = progressed ? 0 : streak + 1;

  // Po `maxStalled` odkladech bez pokroku se už neodkládá — tenhle (další) konec
  // na stejném checkpointu úkol zaparkuje.
  if (!progressed && streak >= maxStalled) return { action: "park", stalled, reason: "stalled" };
  if (totalAllowance >= maxTotal) return { action: "park", stalled, reason: "total" };
  return { action: "defer", stalled };
}

// --- Vstupní brána: špičková rezervace hlídače -----------------------------------

/*
  Hlídač při přijetí KAŽDÉHO požadavku rezervuje horní odhad ceny:
    usd = (input_bound × cena_vstupu + max_tokens × cena_výstupu) / 1e6
    input_bound = UTF-8 bajty payloadu + 512 + 64 × počet zpráv (+128 × nástroj)
  a odmítne ho, když dnešní součet + rezervace > farm_daily_cap_usd. Alias `worker*`
  mapuje na deepseek-v4-pro (1,32 / 3,96 US$ za milion), výstup je shora omezen
  MAX_OUTPUT_TOKENS = 4096.

  Zrcadlo konstant, ne import (Python ↔ TS). Když se v guardu změní PRICES,
  MODEL_ALIASES nebo MAX_OUTPUT_TOKENS, uprav i tady.

  Kontext: produkce 9.–15. 9. 2026, 206 požadavků aliasu worker — rezervace
  p50 0,114, p90 0,174, p99 0,199, max 0,2022 US$ (skutečná cena v průměru 0,003).
  Max odpovídá ~141 kB kontextu; výchozí 140 000 bajtů dává 0,2017 US$.
*/
export const GUARD_MAX_OUTPUT_TOKENS = 4096;
export const GUARD_WORKER_INPUT_USD_PER_M = 1.32;
export const GUARD_WORKER_OUTPUT_USD_PER_M = 3.96;
export const GUARD_REQUEST_ENVELOPE_BYTES = 512;
export const GUARD_WORKER_CONTEXT_BYTES = 140_000;

/** Špičková rezervace hlídače pro jeden požadavek workera s daným kontextem. */
export function guardPeakReservationUsd(contextBytes: number = GUARD_WORKER_CONTEXT_BYTES): number {
  const bytes = Number.isFinite(contextBytes) && contextBytes >= 0 ? contextBytes : GUARD_WORKER_CONTEXT_BYTES;
  return (
    ((bytes + GUARD_REQUEST_ENVELOPE_BYTES) * GUARD_WORKER_INPUT_USD_PER_M +
      GUARD_MAX_OUTPUT_TOKENS * GUARD_WORKER_OUTPUT_USD_PER_M) /
    1_000_000
  );
}

/**
 * Rezervace pro vstupní bránu z env `GUARD_ADMISSION_CONTEXT_BYTES` (nesmyslná
 * hodnota → výchozí). Ani 0 stropy neoslabí: brána vždy bere aspoň per-pokus příděl.
 */
export function guardAdmissionReserveUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GUARD_ADMISSION_CONTEXT_BYTES;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return guardPeakReservationUsd(Number.isFinite(parsed) && parsed >= 0 ? parsed : GUARD_WORKER_CONTEXT_BYTES);
}

/**
 * Rezerva, kterou brána přičte k útratě nad jedním stropem farmy.
 *
 * Nikdy méně než per-pokus příděl (brána tak není volnější než checkBudget) a
 * nikdy víc než `strop − příděl`. Rezerva větší než strop by bránu zavřela už při
 * nulové útratě (třeba po zpřísnění farm_daily_cap_usd na 0,20 nebo s velkým
 * GUARD_ADMISSION_CONTEXT_BYTES) a budget-hold, který používá stejnou bránu, by
 * projekt už nikdy neobnovil. Farma by tiše a trvale stála, ačkoli hlídač malé
 * požadavky pouští — stejná past jako PER_ATTEMPT_BUDGET_USD nad stropem projektu.
 */
export function guardPendingUsd(capUsd: number, perAttemptUsd: number, guardReserveUsd: number): number {
  if (!Number.isFinite(guardReserveUsd)) return perAttemptUsd;
  return Math.max(perAttemptUsd, Math.min(guardReserveUsd, capUsd - perAttemptUsd));
}

/**
 * Stropy farmy (měsíc, den) s rezervou hlídače — jen to, co hlídač skutečně vynucuje.
 * Měsíc první, stejně jako v hlídači i v checkBudget.
 */
export function farmGuardScope(
  spend: SpendSnapshot,
  caps: CapSet,
  perAttemptUsd: number,
  guardReserveUsd: number,
): FarmScope | null {
  if (
    caps.farmMonthlyCapUsd !== undefined &&
    spend.farmMonthUsd !== undefined &&
    spend.farmMonthUsd + guardPendingUsd(caps.farmMonthlyCapUsd, perAttemptUsd, guardReserveUsd) > caps.farmMonthlyCapUsd
  ) {
    return "farm_month";
  }
  if (spend.farmTodayUsd + guardPendingUsd(caps.farmDailyCapUsd, perAttemptUsd, guardReserveUsd) > caps.farmDailyCapUsd) {
    return "farm";
  }
  return null;
}

/**
 * Vstupní brána pokusu. Nejdřív beze změny `checkBudget(spend, caps, perAttempt)`
 * nad VŠEMI stropy. Navíc farma den/měsíc s rezervou hlídače (guardPendingUsd):
 * pokus nemá smysl pouštět, když ho hlídač stejně zastaví hned při prvním větším
 * požadavku (dřív: 0,40 + 0,15 ≤ 0,60 prošlo, pokus spálil kontext a v půlce
 * narazil na „daily limit reached").
 *
 * Rezerva hlídače se ZÁMĚRNĚ nepřičítá ke stropům projektu/uživatele/přání — ty
 * hlídač nevynucuje a jejich využitelnost by jen klesla bez jakéhokoli přínosu.
 * Výsledek je vždy stejně nebo přísnější než samotné checkBudget; stropy nezvedá.
 */
export function admissionBlockedScope(
  spend: SpendSnapshot,
  caps: CapSet,
  perAttemptUsd: number,
  guardReserveUsd: number,
): ReturnType<typeof checkBudget> {
  return checkBudget(spend, caps, perAttemptUsd) ?? farmGuardScope(spend, caps, perAttemptUsd, guardReserveUsd);
}

// --- Texty po zaparkování příliš velkého úkolu ---------------------------------------

/** Co se s přáním stalo po zaparkování úkolu (maybeReplanStuckWish), resp. že selhalo. */
export type ParkFollowUp = "replanned" | "parked" | "skipped" | "waiting" | "none" | "failed";

/**
 * Pravdivé pokračování hlášky podle skutečného výsledku, ne podle přání. Úkol bez
 * přání (refill) žádný plánovač nerozdělí — dostane ho refill jako „moc velký".
 */
export function oversizedParkFollowUp(input: { hasWish: boolean; outcome: ParkFollowUp; memory: boolean }): string {
  if (!input.hasWish) {
    return `Farma ho už neopakuje${input.memory ? "; poučení je v paměti projektu" : ""} a doplňování práce ho smí ` +
      `navrhnout znovu jen jako menší, samostatně ověřitelné kroky.`;
  }
  switch (input.outcome) {
    case "replanned":
      return "Farma ho už neopakuje a přání přeplánuje na menší kroky.";
    case "waiting":
      return "Farma ho už neopakuje; přání přeplánuje, až v něm doběhne ostatní práce.";
    case "parked":
      return "Farma ho už neopakuje; přání už vyčerpalo svá přeplánování, proto ho odkládá a projekt pokračuje jinou prací.";
    default:
      return "Farma ho už neopakuje.";
  }
}
