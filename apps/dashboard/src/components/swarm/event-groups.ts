/**
 * Slučování událostí pro řeku aktivity a živý feed projektu.
 *
 * Proč: hromadná archivace 14. 9. zapsala 201 událostí `backlog_task_archived`
 * a 34 `backlog_wish_archived` se společným `data.run_id` — feed pak neukazoval
 * nic jiného. A šumové typy (`dispatch_error`, `task_deps_pending`) jich mají
 * desítky tisíc. Člověk potřebuje jeden řádek „Archivováno 201 úkolů a 34 přání
 * historické fronty", ne dvě stě stejných.
 *
 * Pravidla:
 *   1. Události se stejným `run_id` (hromadná akce) → jeden řádek, i když
 *      nejdou hned po sobě.
 *   2. Po sobě jdoucí události STEJNÉHO typu ve stejném projektu → jeden řádek
 *      „12× …".
 *   3. Filtr „jen důležité" zahodí šum (`importance: 'noise'`) a debug.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import { eventMeta, type EventImportance, type EventTone } from "../../lib/event-labels";
import { countLabel, TVARY } from "../../lib/plural";

export type FeedLevel = "debug" | "info" | "warn" | "error";

export interface FeedEvent {
  id: string;
  ts: string;
  type: string;
  level: FeedLevel;
  message: string | null;
  project_id?: string | null;
  wish_id?: string | null;
  task_id?: string | null;
  /** `data->>run_id` — společný identifikátor hromadné akce. */
  run_id?: string | null;
  /** `data->>prUrl` — odkaz na pull request (pr_opened). */
  pr_url?: string | null;
  /** `data->>scope` — která rozpočtová vrstva zastavila práci (budget_hold). */
  scope?: string | null;
}

export interface EventGroup {
  key: string;
  /** Typ první (nejnovější) události; u hromadné akce typ, kterého je nejvíc. */
  type: string;
  level: FeedLevel;
  tone: EventTone;
  importance: EventImportance;
  label: string;
  /** Čitelný text řádku (u jedné události její zpráva). */
  text: string;
  count: number;
  /** Nejnovější a nejstarší čas ve skupině. */
  ts: string;
  oldestTs: string;
  /** Nejnovější událost skupiny (odkazy na projekt/přání/úkol/PR). */
  latest: FeedEvent;
  countsByType: Record<string, number>;
}

const LEVEL_RANK: Record<FeedLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function horsiLevel(a: FeedLevel, b: FeedLevel): FeedLevel {
  return (LEVEL_RANK[a] ?? 1) >= (LEVEL_RANK[b] ?? 1) ? a : b;
}

/** Rozpočtové vrstvy z `checkBudget` (@farm/core) → česky. */
const VRSTVY_ROZPOCTU: Record<string, { text: string; denni: boolean }> = {
  project: { text: "denní strop projektu", denni: true },
  farm: { text: "denní strop farmy", denni: true },
  user: { text: "denní strop uživatele", denni: true },
  farm_month: { text: "měsíční strop farmy", denni: false },
  wish: { text: "rozpočet přání", denni: false },
};

/** „project" → „denní strop projektu"; neznámý kód → null (nikdy syrový kód). */
export function budgetScopeLabel(scope: string | null | undefined): string | null {
  return scope ? (VRSTVY_ROZPOCTU[scope]?.text ?? null) : null;
}

function normalizuj(text: string): string {
  return text.toLowerCase().replace(/[.…:;,!\s]+/g, " ").trim();
}

function velke(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const NAVRH = ["návrh", "návrhy", "návrhů"] as const;

/**
 * Lidský text události BEZ zdvojení popisku. Orchestrátor zapisuje interní
 * zprávy („Projekt v budget_hold — překročen strop: project.", „Worker start
 * (worker-build): …") a řeka aktivity je dřív vypisovala za popiskem, takže
 * vzniklo „Pokus odložen kvůli rozpočtu: Práce čeká na rozpočet; …".
 * Prázdný řetězec = zpráva neříká nic navíc, stačí popisek.
 */
export function humanEventText(e: Pick<FeedEvent, "type" | "message" | "scope">, label: string): string {
  const msg = (e.message ?? "").trim();
  let text = msg;
  switch (e.type) {
    case "budget_hold": {
      const kod = e.scope ?? /strop:\s*([a-z_]+)/i.exec(msg)?.[1] ?? null;
      const vrstva = kod ? VRSTVY_ROZPOCTU[kod] : undefined;
      // Dispatch drží projekt, když by DALŠÍ pokus (s rezervou) strop překročil — ne až po překročení.
      if (!vrstva) return "Další pokus by překročil rozpočtový strop, projekt čeká na rozpočet.";
      return vrstva.denni
        ? `Další pokus by překročil ${vrstva.text}. Projekt pokračuje sám po přetočení dne o půlnoci UTC.`
        : `Další pokus by překročil ${vrstva.text}. Projekt čeká, až to rozpočet dovolí.`;
    }
    case "attempt_budget_deferred":
      text = msg.replace(/^Práce čeká na rozpočet;\s*/i, "");
      break;
    case "attempt_started":
      text = msg.replace(/^Worker start \([^)]*\):\s*/i, "");
      break;
    case "attempt_finished":
      text = msg.replace(/^Pokus dokončen,\s*předáno judgeovi\.\s*/i, "Předáno soudci. ");
      break;
    case "task_done":
      text = msg.replace(/^Task hotový:\s*/i, "");
      break;
    case "pr_opened":
      // Odkaz se vykresluje zvlášť; URL v textu je jen šum.
      text = msg.replace(/^PR otevřen(?:\s*\([^)]*\))?:\s*\S*$/i, "");
      break;
    case "refill_done":
      text = msg.replace(/^Refill:\s*/i, "");
      break;
    case "farm_supervisor": {
      const m = /^Supervisor:\s*(\d+)\s+návrh\S*\s*(.*)$/i.exec(msg);
      text = m ? `${countLabel(Number(m[1]), NAVRH)} ${m[2] ?? ""}`.trim() : msg.replace(/^Supervisor:\s*/i, "");
      break;
    }
    case "dispatch_error":
      text = msg.replace(/^Dispatch selhal:\s*/i, "");
      break;
    case "orchestrator_stop":
    case "orchestrator_start":
    case "deploy_running":
      // „Orchestrátor se vypíná." / „Deploy zahájen." říkají totéž co popisek.
      return "";
  }
  text = text.trim();
  if (!text) return "";
  if (normalizuj(text) === normalizuj(label)) return "";
  if (normalizuj(text).startsWith(`${normalizuj(label)} `)) {
    text = text.slice(label.length).replace(/^[\s.:;,—-]+/, "");
  }
  // Velké písmeno jen tam, kde jsme zprávu ořízli; původní zprávu nepřepisujeme.
  return text === msg ? text : velke(text);
}

/**
 * Text sloučeného řádku. Archivaci popisujeme lidsky, ostatní typy „N× popisek".
 */
export function groupText(g: Pick<EventGroup, "count" | "countsByType" | "label" | "latest">): string {
  if (g.count === 1) {
    return humanEventText(g.latest, g.label) || g.label;
  }
  const ukoly = g.countsByType.backlog_task_archived ?? 0;
  const prani = g.countsByType.backlog_wish_archived ?? 0;
  if (ukoly + prani > 0) {
    const casti: string[] = [];
    if (ukoly > 0) casti.push(countLabel(ukoly, TVARY.ukol));
    if (prani > 0) casti.push(countLabel(prani, TVARY.prani));
    const zbytek = g.count - ukoly - prani;
    if (zbytek > 0) casti.push(countLabel(zbytek, TVARY.udalost));
    return `Archivováno ${casti.join(" a ")} historické fronty`;
  }
  return `${g.count}× ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`;
}

export interface GroupOptions {
  /** Zahodit šum a debug (filtr „jen důležité"). */
  onlyImportant?: boolean;
}

/** Vstup: události od NEJNOVĚJŠÍ. Výstup: skupiny od nejnovější. */
export function groupEvents(events: readonly FeedEvent[], opts: GroupOptions = {}): EventGroup[] {
  const skupiny: EventGroup[] = [];
  const podleRunu = new Map<string, EventGroup>();

  for (const e of events) {
    const meta = eventMeta(e.type);
    if (opts.onlyImportant && (meta.importance === "noise" || e.level === "debug")) continue;

    // 1) hromadná akce
    if (e.run_id) {
      const existujici = podleRunu.get(e.run_id);
      if (existujici) {
        pridej(existujici, e);
        continue;
      }
      const g = nova(`run:${e.run_id}`, e);
      podleRunu.set(e.run_id, g);
      skupiny.push(g);
      continue;
    }

    // 2) stejný typ hned po sobě, stejný projekt
    const posledni = skupiny[skupiny.length - 1];
    if (
      posledni &&
      !posledni.key.startsWith("run:") &&
      posledni.type === e.type &&
      (posledni.latest.project_id ?? null) === (e.project_id ?? null)
    ) {
      pridej(posledni, e);
      continue;
    }
    skupiny.push(nova(`ev:${e.id}`, e));
  }

  for (const g of skupiny) {
    // U hromadné akce popisujeme typ, kterého je nejvíc.
    let nejTyp = g.type;
    let nejPocet = -1;
    for (const [typ, pocet] of Object.entries(g.countsByType)) {
      if (pocet > nejPocet) {
        nejTyp = typ;
        nejPocet = pocet;
      }
    }
    if (nejTyp !== g.type) {
      const meta = eventMeta(nejTyp);
      g.type = nejTyp;
      g.label = meta.label;
      g.tone = meta.tone;
      g.importance = meta.importance;
    }
    g.text = groupText(g);
  }
  return skupiny;
}

function nova(key: string, e: FeedEvent): EventGroup {
  const meta = eventMeta(e.type);
  return {
    key,
    type: e.type,
    level: e.level,
    tone: meta.tone,
    importance: meta.importance,
    label: meta.label,
    text: "",
    count: 1,
    ts: e.ts,
    oldestTs: e.ts,
    latest: e,
    countsByType: { [e.type]: 1 },
  };
}

function pridej(g: EventGroup, e: FeedEvent): void {
  g.count += 1;
  g.level = horsiLevel(g.level, e.level);
  g.countsByType[e.type] = (g.countsByType[e.type] ?? 0) + 1;
  if (e.ts > g.ts) {
    g.ts = e.ts;
    g.latest = e;
  }
  if (e.ts < g.oldestTs) g.oldestTs = e.ts;
}

// --- poslední chyby --------------------------------------------------------------

export interface ErrorGroup {
  type: string;
  label: string;
  level: FeedLevel;
  count: number;
  lastTs: string;
  lastMessage: string | null;
  latest: FeedEvent;
}

/**
 * Chyby a varování seskupené podle typu (napříč časem), seřazené od nejčerstvější.
 * Opakované `dispatch_error` je JEDEN problém, ne pět řádků.
 */
export function errorGroups(events: readonly FeedEvent[], limit = 5): ErrorGroup[] {
  const podleTypu = new Map<string, ErrorGroup>();
  for (const e of events) {
    if (e.level !== "error" && e.level !== "warn") continue;
    const g = podleTypu.get(e.type);
    if (g) {
      g.count += 1;
      g.level = horsiLevel(g.level, e.level);
      if (e.ts > g.lastTs) {
        g.lastTs = e.ts;
        g.lastMessage = humanEventText(e, g.label) || null;
        g.latest = e;
      }
      continue;
    }
    const label = eventMeta(e.type).label;
    podleTypu.set(e.type, {
      type: e.type,
      label,
      level: e.level,
      count: 1,
      lastTs: e.ts,
      // Interní zprávu orchestrátoru přeložit, zdvojený popisek vynechat.
      lastMessage: humanEventText(e, label) || null,
      latest: e,
    });
  }
  return [...podleTypu.values()]
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
    .slice(0, limit);
}
