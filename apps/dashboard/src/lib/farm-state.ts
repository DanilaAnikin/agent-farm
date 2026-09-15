/**
 * JEDEN zdroj pravdy o tom, jestli farma běží a proč ne.
 *
 * Dosud se to na každé obrazovce počítalo jinak: hlavička četla `global_pause`,
 * /admin taky `global_pause`, ale vypínač zapisoval `owner_pause`, takže po
 * kliknutí na „Zastavit vše" pilulka skočila zpátky na „Běží", zatímco farma
 * stála. A nikde se nerozlišovalo, KDO pauzu drží — automatický hlídač (levné
 * hodiny, došlý kredit, měsíční strop) se choval stejně jako člověk, takže se
 * ruční „spustit" pokoušelo přebít pauzu, která se má pustit sama.
 *
 * Tenhle soubor je ČISTÁ logika nad syrovým jsonb z `farm_settings` — žádné
 * dotazy, žádné `@/` importy, aby ho `tsx --test` uměl spustit.
 */
import {
  DEFAULT_OFFPEAK_WINDOWS_UTC,
  isOffpeakUtc,
  nextOffpeakStart,
  parseOffpeakWindows,
  type UtcWindow,
} from "./time";
import { formatAtTime, formatTimeShort } from "./format";
import { countLabel, plural, TVARY } from "./plural";

/** Zdroj automatické pauzy tak, jak ho zapisuje orchestrátor. */
export type PauseSource = "owner" | "offpeak" | "credit" | "month" | null;

export type FarmStateCode =
  | "running"
  | "budget_wait"
  | "owner"
  | "budget"
  | "offpeak_expected"
  | "offpeak_overdue"
  | "unknown_pause";

export type FarmTone = "ok" | "warn" | "danger" | "info" | "neutral";

export interface FarmState {
  code: FarmStateCode;
  paused: boolean;
  title: string;
  detail: string;
  tone: FarmTone;
  /** Kdy se farma sama rozjede (ISO), pokud to jde určit. */
  nextResumeAt: string | null;
  /** Jen `budget_wait`: kolik projektů čeká na rozpočet a kolik úkolů mají ve frontě. */
  heldProjects?: number;
  heldQueued?: number;
}

/** Syrové hodnoty z `farm_settings` (jsonb), tak jak přijdou z RPC nebo z REST. */
export interface FarmStateInput {
  owner_pause?: unknown;
  global_pause?: unknown;
  pause_source?: unknown;
  budget_block?: unknown;
  /** `farm_budget_guard_meta.ready`; `null` = hlídač nedostupný, NE „v pořádku". */
  guard_ready?: boolean | null;
  next_resume_at?: unknown;
  offpeak_windows_utc?: unknown;
  /** `farm_run_state()` od migrace 0017: projekty ve stavu `budget_hold`. */
  budget_hold_projects?: unknown;
  /** Čekající úkoly v projektech `budget_hold`. */
  budget_hold_queued?: unknown;
  /** Nejstarší přechod do `budget_hold` (projects.updated_at), ISO. */
  budget_hold_since?: unknown;
  /** Práce v AKTIVNÍCH projektech: fronta, běh, soudce, slučování, specifikace, pracující agenti. */
  active_work?: unknown;
}

/**
 * Pravda = pauza. Čte se `Boolean(value)`, ne `=== true`, přesně jako
 * v `packages/db/src/pause.ts` — kdyby někdo do jsonb zapsal `"true"`,
 * musí to platit v celé farmě stejně.
 */
export function isFarmPaused(input: {
  global_pause?: unknown;
  owner_pause?: unknown;
}): boolean {
  return Boolean(input.global_pause) || Boolean(input.owner_pause);
}

/** Zdroj pauzy ze syrové hodnoty (jsonb `null` i SQL NULL → null). */
export function parsePauseSource(raw: unknown): PauseSource {
  if (raw === "owner" || raw === "offpeak" || raw === "credit" || raw === "month") return raw;
  return null;
}

/** Lidský popis, kdo pauzu drží. */
export function pauseLabel(pauseSource: unknown): string {
  switch (parsePauseSource(pauseSource)) {
    case "owner":
      return "pozastaveno majitelem";
    case "offpeak":
      return "automatická pauza: drahé hodiny (mimo levné okno)";
    case "credit":
      return "automatická pauza: došel kredit u poskytovatele";
    case "month":
      return "automatická pauza: vyčerpaný měsíční strop";
    default:
      return "pozastaveno, zdroj neznámý";
  }
}

export interface ResumeAction {
  /** Smí se shodit i `global_pause`, nebo patří automatu? */
  clearGlobalPause: boolean;
  message: string;
}

/**
 * Co se má stát, když majitel zmáčkne „spustit".
 *
 * TVRDÉ PRAVIDLO: ruční tlačítko NESMÍ přebít automatickou pauzu. Když farmu
 * drží hlídač (levné hodiny, došlý kredit, měsíční strop), uvolní se jen
 * `owner_pause` a `global_pause` zůstane — jinak by ruční klik obešel rozpočtovou
 * pojistku. UI tu hlášku MUSÍ zobrazit, jinak to vypadá, že se nic nestalo.
 */
export function resolveResumeAction(pauseSource: unknown): ResumeAction {
  const zdroj = parsePauseSource(pauseSource);
  if (zdroj === null || zdroj === "owner") {
    return { clearGlobalPause: true, message: "Farma spuštěna." };
  }
  const duvod =
    zdroj === "offpeak"
      ? "mimo špičku"
      : zdroj === "credit"
        ? "došlý kredit"
        : "měsíční strop";
  return {
    clearGlobalPause: false,
    message: `Vypínač majitele uvolněn, farmu ale drží automatická pauza (${duvod}) — spustí se sama.`,
  };
}

/**
 * Nezáporné číslo z jsonb, jinak fallback. NIKDY nevrátí NaN: `Number(null)`
 * je 0, `Number(undefined)` je NaN a `NaN / cap` pak v UI vyrobilo „NaN %"
 * a prázdný ProgressBar. Nula je platný příkaz „neutrácej nic", proto se
 * nepřepisuje. Stejné chování jako `capFrom` v orchestrátoru.
 */
export function capFromSetting(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isoNeboNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Blokuje rozpočet? `false` je platná hodnota „neblokuje", cokoli jiného blokuje. */
export function isBudgetBlocked(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (raw === false) return false;
  if (raw === "false") return false;
  return true;
}

/** Nezáporný celý počet z jsonb; chybějící nebo nesmyslná hodnota → null („nevím", ne nula). */
function pocetNeboNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Nejbližší půlnoc UTC po `now` — tehdy se přetočí denní strop a smyčka
 * budget-hold vrátí projekty do práce (stejně jako `nextResetUtc` v @farm/core).
 */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}

const CEKA = ["čeká", "čekají", "čeká"] as const;

/** Text důvodu z `budget_block`, když je to řetězec. */
function budgetBlockDuvod(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" && raw !== "false" ? raw : null;
}

/**
 * Stavový automat farmy. Pořadí JE priorita — kdo pauzu drží „výš", ten ji
 * vlastní a jeho hlášku člověk vidí:
 *
 *   1. owner_pause      — vypínač majitele je nadřazený všemu.
 *   2. rozpočet         — hlídač není připraven nebo blokuje (peníze > cokoli).
 *   3. offpeak ve špičce— stojí správně, sama se rozjede v levném okně.
 *   4. offpeak mimo špičku — měla se pustit a nepustila = PORUCHA.
 *   5. pauza bez zdroje — nikdo se k ní nehlásí, taky porucha.
 *   6. běží, ale veškerá práce stojí v projektech `budget_hold` → čeká na rozpočet.
 *   7. běží.
 */
export function farmState(input: FarmStateInput, now: Date = new Date()): FarmState {
  const okna: UtcWindow[] =
    input.offpeak_windows_utc === undefined || input.offpeak_windows_utc === null
      ? DEFAULT_OFFPEAK_WINDOWS_UTC
      : parseOffpeakWindows(input.offpeak_windows_utc);
  const zdroj = parsePauseSource(input.pause_source);
  const naplanovane = isoNeboNull(input.next_resume_at);

  // 1) majitel
  if (Boolean(input.owner_pause)) {
    return {
      code: "owner",
      paused: true,
      title: "Farmu pozastavil majitel",
      detail:
        "Nouzové zastavení je zapnuté. Farma sama nic nespustí, dokud ho nevypneš.",
      tone: "warn",
      nextResumeAt: null,
    };
  }

  // 2) rozpočet — hlídač LiteLLM je autoritativní brána před každým voláním modelu
  if (input.guard_ready === false || isBudgetBlocked(input.budget_block)) {
    const duvod = budgetBlockDuvod(input.budget_block);
    return {
      code: "budget",
      paused: true,
      title: "Farma stojí na rozpočtu",
      detail:
        input.guard_ready === false
          ? "Rozpočtový hlídač zablokoval nové požadavky (čeká na kontrolu). Nic se nezadává."
          : `Orchestrátor zastavil práci kvůli rozpočtu${duvod ? ` (${duvod})` : ""}.`,
      tone: "danger",
      nextResumeAt: naplanovane,
    };
  }

  const globalni = Boolean(input.global_pause);
  if (!globalni) {
    // 6) Farma běží, ale v aktivních projektech nic není a projekty s prací čekají
    // v `budget_hold` na přetočení dne. Hlavička dřív psala „Farma pracuje" a velín
    // „nemá práci — sama si ji doplní", přestože fronta čekala na rozpočet.
    const drzene = pocetNeboNull(input.budget_hold_projects);
    const praceAktivnich = pocetNeboNull(input.active_work);
    if (drzene !== null && drzene > 0 && praceAktivnich === 0) {
      const fronta = pocetNeboNull(input.budget_hold_queued) ?? 0;
      const od = isoNeboNull(input.budget_hold_since);
      const pristiDen = nextUtcMidnight(now);
      // Projekt drží rozpočet už přes půlnoc UTC → smyčka ho vrátí během pár minut.
      const denSePretocil = od !== null && nextUtcMidnight(new Date(od)).getTime() <= now.getTime();
      const kdo = `${countLabel(drzene, TVARY.projekt)} ${plural(drzene, CEKA)}`;
      const veFronte = fronta > 0 ? ` (ve frontě ${countLabel(fronta, TVARY.ukol)})` : "";
      return {
        code: "budget_wait",
        paused: false,
        title: "Farma čeká na rozpočet",
        detail: denSePretocil
          ? `${kdo} na obnovení rozpočtu${veFronte}. Rozpočtový den se už přetočil, farma je vrátí do práce během několika minut.`
          : `${kdo} na nový rozpočtový den${veFronte}. Farma pokračuje sama ${formatAtTime(pristiDen)} (Europe/Prague), po přetočení denního stropu o půlnoci UTC.`,
        tone: "info",
        nextResumeAt: denSePretocil ? null : pristiDen.toISOString(),
        heldProjects: drzene,
        heldQueued: fronta,
      };
    }
    return {
      code: "running",
      paused: false,
      title: "Farma běží",
      detail: "Farma pracuje a práci si doplňuje sama.",
      tone: "ok",
      nextResumeAt: null,
    };
  }

  // 3) / 4) automatická pauza kvůli drahým hodinám
  if (zdroj === "offpeak") {
    const vLevnemOkne = isOffpeakUtc(now, okna);
    if (!vLevnemOkne) {
      const start = nextOffpeakStart(now, okna);
      const kdy = naplanovane ?? (start ? start.toISOString() : null);
      return {
        code: "offpeak_expected",
        paused: true,
        title: "Farma čeká na levné hodiny",
        detail: kdy
          ? `Teď je špička, tokeny stojí násobek. Farma se sama rozjede v ${formatTimeShort(kdy)} (Europe/Prague).`
          : "Teď je špička, tokeny stojí násobek. Farma se rozjede sama, jakmile začne levné okno.",
        tone: "info",
        nextResumeAt: kdy,
      };
    }
    return {
      code: "offpeak_overdue",
      paused: true,
      title: "Farma se měla sama rozjet a nerozjela",
      detail:
        "Levné okno už běží, ale pauza se zdrojem „mimo špičku“ pořád platí. Plánovač ji měl zrušit — tohle je porucha, ne plán.",
      tone: "danger",
      nextResumeAt: naplanovane,
    };
  }

  // Ostatní automatické zdroje (kredit, měsíc) — stojí správně, pustí se samy.
  if (zdroj === "credit" || zdroj === "month") {
    return {
      code: "budget",
      paused: true,
      title:
        zdroj === "credit" ? "Farma stojí: došel kredit" : "Farma stojí: měsíční strop",
      detail:
        zdroj === "credit"
          ? "U poskytovatele došel kredit. Po jeho doplnění se farma rozjede sama."
          : "Vyčerpal se měsíční strop farmy. Po přetočení měsíce se farma rozjede sama.",
      tone: "warn",
      nextResumeAt: naplanovane,
    };
  }

  // Historický zápis: dřív se vypínač majitele ukládal do `global_pause` se
  // zdrojem 'owner'. Pořád to má říct „pozastavil majitel", ne „zdroj neznámý".
  if (zdroj === "owner") {
    return {
      code: "owner",
      paused: true,
      title: "Farmu pozastavil majitel",
      detail: "Globální pauzu drží vypínač majitele. Žádný hlídač ji sám nezruší.",
      tone: "warn",
      nextResumeAt: null,
    };
  }

  // 5) pauza, ke které se nikdo nehlásí
  return {
    code: "unknown_pause",
    paused: true,
    title: "Farma je pozastavená, zdroj neznámý",
    detail:
      "Globální pauza platí, ale žádný hlídač se k ní nehlásí. Nikdo ji sám nezruší.",
    tone: "danger",
    nextResumeAt: naplanovane,
  };
}
