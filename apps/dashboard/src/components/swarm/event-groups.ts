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

/**
 * Text sloučeného řádku. Archivaci popisujeme lidsky, ostatní typy „N× popisek".
 */
export function groupText(g: Pick<EventGroup, "count" | "countsByType" | "label" | "latest">): string {
  if (g.count === 1) {
    const msg = (g.latest.message ?? "").trim();
    return msg || g.label;
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
        g.lastMessage = e.message;
        g.latest = e;
      }
      continue;
    }
    podleTypu.set(e.type, {
      type: e.type,
      label: eventMeta(e.type).label,
      level: e.level,
      count: 1,
      lastTs: e.ts,
      lastMessage: e.message,
      latest: e,
    });
  }
  return [...podleTypu.values()]
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
    .slice(0, limit);
}
