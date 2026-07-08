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
  stopped: [], // terminální
};

const WISH: Record<WishStatus, WishStatus[]> = {
  new: ["specifying"],
  specifying: ["awaiting_spec_approval", "active", "new"], // "new" = recovery při selhání specifikace/plánu
  awaiting_spec_approval: ["active", "specifying", "new"], // schváleno / vráceno k přepracování / reject
  active: ["done", "parked", "specifying"],
  done: [],
  parked: ["active"], // znovu otevře jen člověk
};

const TASK: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "parked"],
  running: ["judging", "failed", "queued"], // queued = infra kill (bez inkrementu)
  judging: ["done", "queued", "parked"], // reject → queued; 3. fail/escalate → parked
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
