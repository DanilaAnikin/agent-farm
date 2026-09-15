/**
 * Věta o stavu farmy pro nadpis velína, prázdné stavy a pás „Stav farmy".
 *
 * Proč: dřívější nadpisy velína tvrdily, že farma spí a čeká na přání od člověka,
 * a to byla lež. Farma nestála kvůli chybějícím přáním, ale kvůli zamčenému
 * rozpočtovému hlídači, drahým hodinám nebo pauze — a vyzývaly člověka k zásahu,
 * který farma zvládne sama. Tady se věta odvozuje z `farmState()` (jediný zdroj
 * pravdy o pauze) a z toho, co farma právě dělá.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import type { FarmState, FarmTone } from "../../lib/farm-state";
import { formatAtTime, formatDate, formatDuration, formatTimeShort } from "../../lib/format";
import { countLabel, plural, TVARY } from "../../lib/plural";
import {
  DEFAULT_OFFPEAK_WINDOWS_UTC,
  hhmmToMinutes,
  isOffpeakUtc,
  type UtcWindow,
} from "../../lib/time";

export interface FarmHeadline {
  title: string;
  detail: string;
  tone: FarmTone;
}

export interface FarmHeadlineInput {
  state: FarmState;
  /** Agenti, kteří právě pracují. */
  busyAgents: number;
  /** Čekající úkoly v AKTIVNÍCH projektech. */
  queuedActive: number;
  /** Od kdy stav platí (updated_at pauzy / ready_since hlídače). */
  sinceIso?: string | null;
  /** Levná okna (UTC) — kvůli „plánovač ji měl pustit v …". */
  offpeakWindows?: UtcWindow[];
  now?: Date;
}

/** Začátek levného okna, ve kterém `now` právě je (UTC). Mimo okno → null. */
export function currentOffpeakStart(
  now: Date,
  windows: UtcWindow[] = DEFAULT_OFFPEAK_WINDOWS_UTC,
): Date | null {
  if (!isOffpeakUtc(now, windows)) return null;
  const ted = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const okno of windows) {
    const od = hhmmToMinutes(okno.start);
    const do_ = hhmmToMinutes(okno.end);
    if (od === null || do_ === null) continue;
    const uvnitr = od <= do_ ? ted >= od && ted < do_ : ted >= od || ted < do_;
    if (!uvnitr) continue;
    const zacatek = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, od, 0, 0),
    );
    // okno přes půlnoc, teď jsme v jeho ranní části → začalo včera
    if (od > do_ && ted < do_) zacatek.setUTCDate(zacatek.getUTCDate() - 1);
    return zacatek;
  }
  return null;
}

/**
 * Krátký důvod pro řádek na kartě projektu („Projekt aktivní · farma stojí: …").
 * `null` = farma běží.
 */
export function farmShortReason(state: FarmState): string | null {
  switch (state.code) {
    case "running":
    // Farma neběží naprázdno kvůli pauze — stojí jen projekty v budget_hold a ty to
    // říkají vlastním stavem („Projekt čeká na rozpočet").
    case "budget_wait":
      return null;
    case "owner":
      return "pozastavil ji majitel";
    case "budget":
      if (state.title.includes("kredit")) return "došel kredit u poskytovatele";
      if (state.title.includes("měsíční")) return "vyčerpaný měsíční strop";
      return "zamčený rozpočtový hlídač";
    case "offpeak_expected":
      return state.nextResumeAt
        ? `drahé hodiny, sama se rozjede v ${formatTimeShort(state.nextResumeAt)}`
        : "drahé hodiny, sama se rozjede v levném okně";
    case "offpeak_overdue":
      return "plánovač ji nepustil";
    default:
      return "pauza bez známého zdroje";
  }
}

const PRACUJE = ["pracuje", "pracují", "pracuje"] as const;
const CEKA = ["čeká", "čekají", "čeká"] as const;

export function farmHeadline(input: FarmHeadlineInput): FarmHeadline {
  const now = input.now ?? new Date();
  const { state } = input;
  // „2 úkoly čekají" (podmět napřed) do titulku, „čekají 2 úkoly" do věty za příslovečným určením.
  const fronta = `${countLabel(input.queuedActive, TVARY.ukol)} ${plural(input.queuedActive, CEKA)}`;
  const vefronte = `Ve frontě aktivních projektů ${plural(input.queuedActive, CEKA)} ${countLabel(input.queuedActive, TVARY.ukol)}.`;

  switch (state.code) {
    case "owner":
      return {
        title: "Farma je pozastavená majitelem",
        detail: `Sama nic nespustí, dokud vypínač nevypneš. ${vefronte}`,
        tone: "warn",
      };
    case "budget": {
      // Kredit a měsíční strop mají vlastní titulek z farmState; hlídač a budget_block tuhle větu.
      if (state.title.includes("kredit") || state.title.includes("měsíční")) {
        return { title: state.title, detail: state.detail, tone: state.tone };
      }
      const od = input.sinceIso ? ` od ${formatDate(input.sinceIso)}` : "";
      return {
        title: `Rozpočtový hlídač zablokoval nové požadavky${od}`,
        detail: `${state.detail} Farma se rozjede sama, jakmile hlídač požadavky zase pustí.`,
        tone: "danger",
      };
    }
    case "budget_wait": {
      const n = state.heldProjects ?? 0;
      const q = state.heldQueued ?? 0;
      const veFronte = q > 0 ? `Ve frontě ${plural(q, CEKA)} ${countLabel(q, TVARY.ukol)}. ` : "";
      if (!state.nextResumeAt) {
        return {
          title: "Rozpočtový den se přetočil — farma vrací projekty do práce",
          detail: state.detail,
          tone: "info",
        };
      }
      const kdo = n > 0 ? `${countLabel(n, TVARY.projekt)} ${plural(n, CEKA)}` : "Projekty čekají";
      return {
        title: `${kdo} na nový rozpočtový den — farma pokračuje sama ${formatAtTime(state.nextResumeAt)}`,
        detail: `${veFronte}Do přetočení denního stropu o půlnoci UTC na nich farma nepracuje, pak pokračuje sama.`,
        tone: "info",
      };
    }
    case "offpeak_expected": {
      const kdy = state.nextResumeAt;
      if (!kdy) {
        return {
          title: "Drahé hodiny DeepSeeku — farma se sama rozjede v levném okně",
          detail: state.detail,
          tone: "info",
        };
      }
      const za = Math.max(0, Math.round((new Date(kdy).getTime() - now.getTime()) / 1000));
      return {
        title: `Drahé hodiny DeepSeeku — farma se sama rozjede v ${formatTimeShort(kdy)}`,
        // Časové pásmo patří k absolutnímu času (titulek, patička pásu), ne k délce trvání.
        detail: `Za ${formatDuration(za < 60 ? 60 : za)}. Do té doby stojí záměrně, tokeny ve špičce stojí násobek.`,
        tone: "info",
      };
    }
    case "offpeak_overdue": {
      const zacatek = currentOffpeakStart(now, input.offpeakWindows ?? DEFAULT_OFFPEAK_WINDOWS_UTC);
      return {
        title: zacatek
          ? `Plánovač měl farmu pustit v ${formatTimeShort(zacatek)} a nepustil`
          : "Plánovač měl farmu pustit a nepustil",
        detail: state.detail,
        tone: "danger",
      };
    }
    case "unknown_pause":
      return { title: state.title, detail: state.detail, tone: state.tone };
    case "running":
    default: {
      if (input.busyAgents > 0) {
        return {
          title: `Farma běží — ${countLabel(input.busyAgents, TVARY.agent)} ${plural(input.busyAgents, PRACUJE)}`,
          detail:
            input.queuedActive > 0
              ? vefronte
              :"Fronta aktivních projektů je prázdná, další práci si farma doplní sama.",
          tone: "ok",
        };
      }
      if (input.queuedActive > 0) {
        return {
          title: `Farma běží, ${fronta} na volný slot`,
          detail: "Dispečer je spustí v příštím kole.",
          tone: "ok",
        };
      }
      return {
        title: "Farma běží a nemá práci — sama si ji doplní",
        detail: "Manažer v příštím kole vybere další práci z repozitářů aktivních projektů.",
        tone: "ok",
      };
    }
  }
}
