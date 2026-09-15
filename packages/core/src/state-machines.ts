import type {
  AttemptStatus,
  ProjectStatus,
  TaskStatus,
  WishStatus,
} from "@farm/db";
import { InvalidTransitionError } from "./errors.js";

/**
 * Kanonické přechody (OVERVIEW §7). Klíč = odkud, hodnota = kam smí.
 * assertTransition() vyhodí InvalidTransitionError na neplatný přechod.
 */

const PROJECT: Record<ProjectStatus, ProjectStatus[]> = {
  active: ["paused", "budget_hold", "stopped"],
  paused: ["active", "stopped"],
  budget_hold: ["active", "paused", "stopped"], // auto-resume při resetu okna → active
  // 'stopped' NENÍ terminální: slouží i jako čekárna postupného rolloutu
  // (farm-project-rollout.py zapíná projekty po jednom, když projdou zdravotní
  // brány). Musí to být legální přechod, jinak by projectMachine.assert() na
  // téhle cestě vyhodil výjimku. Pozn.: 'paused' se na čekárnu použít NEDÁ —
  // budget-hold.ts každý 'paused' projekt sám probudí po denním resetu.
  stopped: ["active"],
};

const WISH: Record<WishStatus, WishStatus[]> = {
  new: ["specifying"],
  specifying: ["awaiting_spec_approval", "active", "new"], // "new" = recovery při selhání specifikace/plánu
  awaiting_spec_approval: ["active", "specifying", "new"], // schváleno / vráceno k přepracování / reject
  active: ["done", "parked", "specifying"],
  done: [],
  parked: ["active"], // znovu otevře jen člověk
};

/**
 * Proč přibyl stav `merging`: úkol NENÍ hotový otevřením pull requestu, ale až
 * potvrzeným sloučením. Dřív soudce u `repo_mode='existing'` otevřel PR a úkol
 * rovnou označil za `done` — závislé úkoly se tím rozjely nad kódem, který
 * v hlavní větvi vůbec nebyl, a když se PR nikdy nesloučil, farma si myslela,
 * že práci doručila. `merging` je tedy skutečný čekací stav doručení: z něj se
 * jde do `done` (merge potvrzen), zpět do `queued` (PR se musí opravit, worker
 * pushne na tutéž větev) nebo do `parked` (doručení vzdáno, s park_reason).
 * `judging → done` zůstává legální kvůli `repo_mode='new'`, kde se merguje
 * rovnou do main a žádný PR se neotevírá.
 */
const TASK: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "parked"],
  running: ["judging", "failed", "queued"], // queued = infra kill (bez inkrementu)
  judging: ["merging", "done", "queued", "parked"], // merging = otevřen PR; reject → queued
  merging: ["done", "queued", "parked"], // done = PR sloučen; queued = oprava na téže větvi
  failed: ["queued", "parked"],
  done: [],
  parked: ["queued"], // jen člověk
};

const ATTEMPT: Record<AttemptStatus, AttemptStatus[]> = {
  running: ["succeeded", "rejected", "failed", "aborted"],
  succeeded: [],
  rejected: [],
  failed: [],
  aborted: [],
};

function check<S extends string>(
  table: Record<S, S[]>,
  entity: string,
  from: S,
  to: S,
): void {
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}

export function canTransition<S extends string>(
  table: Record<S, S[]>,
  from: S,
  to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

export const projectMachine = {
  table: PROJECT,
  assert: (from: ProjectStatus, to: ProjectStatus) => check(PROJECT, "project", from, to),
  can: (from: ProjectStatus, to: ProjectStatus) => canTransition(PROJECT, from, to),
};

export const wishMachine = {
  table: WISH,
  assert: (from: WishStatus, to: WishStatus) => check(WISH, "wish", from, to),
  can: (from: WishStatus, to: WishStatus) => canTransition(WISH, from, to),
};

export const taskMachine = {
  table: TASK,
  assert: (from: TaskStatus, to: TaskStatus) => check(TASK, "task", from, to),
  can: (from: TaskStatus, to: TaskStatus) => canTransition(TASK, from, to),
};

export const attemptMachine = {
  table: ATTEMPT,
  assert: (from: AttemptStatus, to: AttemptStatus) => check(ATTEMPT, "attempt", from, to),
  can: (from: AttemptStatus, to: AttemptStatus) => canTransition(ATTEMPT, from, to),
};
