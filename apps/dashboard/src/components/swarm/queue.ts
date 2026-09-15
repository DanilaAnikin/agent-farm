/**
 * Fronta a postup — čistá logika nad RPC `task_rollup()` a `wish_rollup()`.
 *
 * Proč zvlášť: dlaždice „FRONTA 102" počítala hlavně úkoly POZASTAVENÝCH projektů
 * (aktivní měly ve frontě 2), „POSTUP" dělil i archivovanou historickou frontou
 * (ripieno 20 % místo 94 %) a „AKTIVNÍ PŘÁNÍ 28" sčítalo přání, na kterých nikdo
 * pracovat nebude. Tady se to rozpadá tak, aby hlavní číslo bylo to, co farma
 * skutečně odpracuje, a zbytek šel do podřádku.
 *
 * Bez `@/` importů — testuje se přes `tsx --test`.
 */
import { countLabel, plural, TVARY } from "../../lib/plural";

/** Řádek z `task_rollup()` (bigint přijde z PostgRESTu jako number i string). */
export interface TaskRollupInput {
  project_id: string;
  project_status: string;
  queued: number | string | null;
  running: number | string | null;
  judging: number | string | null;
  merging: number | string | null;
  done: number | string | null;
  failed: number | string | null;
  parked_live: number | string | null;
  parked_archived: number | string | null;
  last_activity: string | null;
}

export interface WishRollupInput {
  project_id: string;
  project_status: string;
  status: string;
  cnt: number | string | null;
}

function n(v: number | string | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Projekt, na kterém farma smí pracovat. Vše ostatní (paused/stopped/budget_hold) stojí. */
export function isProjectRunning(status: string): boolean {
  return status === "active";
}

export interface QueueBreakdown {
  queuedActive: number;
  runningActive: number;
  judgingActive: number;
  mergingActive: number;
  /** Čekající úkoly v pozastavených projektech — farma na nich pracovat nebude, dokud je někdo nepustí. */
  queuedPaused: number;
  /**
   * Čekající úkoly v projektech `budget_hold`. NEJSOU pozastavené: pustí se samy
   * po přetočení rozpočtového dne, proto se nesmí schovat do „v pozastavených".
   */
  queuedBudgetHold: number;
  parkedLive: number;
  parkedArchived: number;
}

export function queueBreakdown(rows: readonly TaskRollupInput[]): QueueBreakdown {
  const b: QueueBreakdown = {
    queuedActive: 0,
    runningActive: 0,
    judgingActive: 0,
    mergingActive: 0,
    queuedPaused: 0,
    queuedBudgetHold: 0,
    parkedLive: 0,
    parkedArchived: 0,
  };
  for (const r of rows) {
    b.parkedLive += n(r.parked_live);
    b.parkedArchived += n(r.parked_archived);
    if (isProjectRunning(r.project_status)) {
      b.queuedActive += n(r.queued);
      b.runningActive += n(r.running);
      b.judgingActive += n(r.judging);
      b.mergingActive += n(r.merging);
    } else if (r.project_status === "budget_hold") {
      b.queuedBudgetHold += n(r.queued);
    } else {
      b.queuedPaused += n(r.queued);
    }
  }
  return b;
}

/** Slovesa u počtu musí souhlasit s číslem („2 úkoly čekají", ne „2 čeká"). */
export const CEKA = ["čeká", "čekají", "čeká"] as const;
export const SLUCUJE = ["se slučuje", "se slučují", "se slučuje"] as const;

/** „2 úkoly čekají (aktivní projekty)". */
export function queueHeadline(b: QueueBreakdown): string {
  return `${countLabel(b.queuedActive, TVARY.ukol)} ${plural(b.queuedActive, CEKA)} (aktivní projekty)`;
}

/** „1 u soudce · 100 v pozastavených projektech"; prázdné → null. */
export function queueSubline(b: QueueBreakdown): string | null {
  const casti: string[] = [];
  if (b.runningActive > 0) casti.push(`${b.runningActive} v práci`);
  if (b.judgingActive > 0) casti.push(`${b.judgingActive} u soudce`);
  if (b.mergingActive > 0) casti.push(`${b.mergingActive} ${plural(b.mergingActive, SLUCUJE)}`);
  if (b.queuedBudgetHold > 0) casti.push(`${b.queuedBudgetHold} ${plural(b.queuedBudgetHold, CEKA)} na rozpočet`);
  if (b.queuedPaused > 0) casti.push(`${b.queuedPaused} v pozastavených projektech`);
  return casti.length > 0 ? casti.join(" · ") : null;
}

/**
 * Varování JEN když je to opravdu divné: farma běží, v aktivních projektech
 * čeká práce, a přesto nikdo nepracuje. Plná fronta pozastaveného projektu ani
 * fronta za zavřenou farmou poplach nejsou — to je vysvětlené jinde.
 */
export function queueTone(
  b: QueueBreakdown,
  ctx: { farmRunning: boolean; busyAgents: number },
): "warn" | "default" {
  const vPraci = b.runningActive + b.judgingActive + b.mergingActive;
  return ctx.farmRunning && b.queuedActive > 0 && ctx.busyAgents === 0 && vPraci === 0
    ? "warn"
    : "default";
}

// --- postup projektu -----------------------------------------------------------

export interface ProjectProgress {
  done: number;
  inProgress: number;
  parkedLive: number;
  failed: number;
  archived: number;
  /** Celek BEZ archivu — archivovaná historická fronta není nedodělaná práce. */
  denominator: number;
  ratio: number;
}

export function projectProgress(row: TaskRollupInput | null | undefined): ProjectProgress {
  if (!row) {
    return { done: 0, inProgress: 0, parkedLive: 0, failed: 0, archived: 0, denominator: 0, ratio: 0 };
  }
  const done = n(row.done);
  const inProgress = n(row.queued) + n(row.running) + n(row.judging) + n(row.merging);
  const parkedLive = n(row.parked_live);
  const failed = n(row.failed);
  const archived = n(row.parked_archived);
  const denominator = done + inProgress + parkedLive + failed;
  return {
    done,
    inProgress,
    parkedLive,
    failed,
    archived,
    denominator,
    ratio: denominator > 0 ? done / denominator : 0,
  };
}

/** „31 hotovo · 2 rozpracováno · 121 v archivu" — nuly (kromě hotových) se vynechají. */
export function progressBreakdown(p: ProjectProgress): string {
  const casti = [`${p.done} hotovo`];
  if (p.inProgress > 0) casti.push(`${p.inProgress} rozpracováno`);
  if (p.parkedLive > 0) casti.push(`${p.parkedLive} zaparkováno`);
  if (p.failed > 0) casti.push(`${p.failed} selhalo`);
  if (p.archived > 0) casti.push(`${p.archived} v archivu`);
  return casti.join(" · ");
}

// --- otevřená přání ------------------------------------------------------------

export interface WishBreakdown {
  /** Otevřená přání v běžících projektech — to, co farma reálně řeší. */
  openActive: number;
  /** Otevřená přání v pozastavených (nebo zastavených) projektech. */
  openPaused: number;
  /** Otevřená přání v projektech, které čekají na rozpočet — pustí se samy. */
  openBudgetHold?: number;
  openByProject: Map<string, number>;
}

export function wishBreakdown(rows: readonly WishRollupInput[]): WishBreakdown {
  const out: WishBreakdown = { openActive: 0, openPaused: 0, openBudgetHold: 0, openByProject: new Map() };
  for (const r of rows) {
    const c = n(r.cnt);
    out.openByProject.set(r.project_id, (out.openByProject.get(r.project_id) ?? 0) + c);
    if (isProjectRunning(r.project_status)) out.openActive += c;
    else if (r.project_status === "budget_hold") out.openBudgetHold = (out.openBudgetHold ?? 0) + c;
    else out.openPaused += c;
  }
  return out;
}

const ROZPRACOVANE = ["rozpracované", "rozpracovaná", "rozpracovaných"] as const;

/** „1 rozpracované · 27 čeká v pozastavených projektech". */
export function wishBreakdownLine(b: WishBreakdown): string {
  const casti = [`${b.openActive} ${plural(b.openActive, ROZPRACOVANE)}`];
  const naRozpocet = b.openBudgetHold ?? 0;
  if (naRozpocet > 0) casti.push(`${naRozpocet} ${plural(naRozpocet, CEKA)} na rozpočet`);
  if (b.openPaused > 0) casti.push(`${b.openPaused} ${plural(b.openPaused, CEKA)} v pozastavených projektech`);
  return casti.join(" · ");
}
