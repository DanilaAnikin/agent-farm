import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attemptMachine,
  projectMachine,
  taskMachine,
  wishMachine,
} from "./state-machines.js";
import { InvalidTransitionError } from "./errors.js";

/**
 * Kompletní pokrytí přechodů stavových strojů.
 * Každý legální přechod z tabulky musí projít .assert bez výjimky,
 * reprezentativní neplatné přechody musí vyhodit InvalidTransitionError,
 * .can vrací odpovídající boolean a terminální stavy nedovolí nic.
 */

// Pomocník: ověří, že KAŽDÝ legální přechod v tabulce projde a .can je true.
function assertAllLegal<S extends string>(machine: {
  table: Record<S, S[]>;
  assert: (from: S, to: S) => void;
  can: (from: S, to: S) => boolean;
}): void {
  for (const from of Object.keys(machine.table) as S[]) {
    for (const to of machine.table[from]) {
      assert.doesNotThrow(() => machine.assert(from, to), `${from} → ${to} má být legální`);
      assert.equal(machine.can(from, to), true, `can(${from}, ${to}) má být true`);
    }
  }
}

// Pomocník: ověří, že každý přechod MIMO tabulku vyhodí a .can je false.
function assertIllegalExhaustive<S extends string>(
  machine: {
    table: Record<S, S[]>;
    assert: (from: S, to: S) => void;
    can: (from: S, to: S) => boolean;
  },
): void {
  const states = Object.keys(machine.table) as S[];
  for (const from of states) {
    const allowed = new Set(machine.table[from]);
    for (const to of states) {
      if (allowed.has(to)) continue;
      assert.throws(
        () => machine.assert(from, to),
        InvalidTransitionError,
        `${from} → ${to} má být neplatný`,
      );
      assert.equal(machine.can(from, to), false, `can(${from}, ${to}) má být false`);
    }
  }
}

test("projectMachine: všechny legální přechody projdou", () => {
  assertAllLegal(projectMachine);
});

test("wishMachine: všechny legální přechody projdou", () => {
  assertAllLegal(wishMachine);
});

test("taskMachine: všechny legální přechody projdou", () => {
  assertAllLegal(taskMachine);
});

test("attemptMachine: všechny legální přechody projdou", () => {
  assertAllLegal(attemptMachine);
});

test("projectMachine: neplatné přechody vyhodí", () => {
  assertIllegalExhaustive(projectMachine);
});

test("wishMachine: neplatné přechody vyhodí", () => {
  assertIllegalExhaustive(wishMachine);
});

test("taskMachine: neplatné přechody vyhodí", () => {
  assertIllegalExhaustive(taskMachine);
});

test("attemptMachine: neplatné přechody vyhodí", () => {
  assertIllegalExhaustive(attemptMachine);
});

test("reprezentativní neplatné přechody vyhodí InvalidTransitionError", () => {
  assert.throws(() => projectMachine.assert("active", "active"), InvalidTransitionError);
  assert.throws(() => wishMachine.assert("new", "done"), InvalidTransitionError);
  assert.throws(() => taskMachine.assert("queued", "done"), InvalidTransitionError);
  assert.throws(() => attemptMachine.assert("running", "running"), InvalidTransitionError);
});

test("chyba nese entitu a směr přechodu", () => {
  try {
    taskMachine.assert("queued", "done");
    assert.fail("mělo vyhodit");
  } catch (e) {
    assert.ok(e instanceof InvalidTransitionError);
    assert.equal((e as InvalidTransitionError).name, "InvalidTransitionError");
    assert.match((e as Error).message, /task/);
    assert.match((e as Error).message, /queued/);
    assert.match((e as Error).message, /done/);
  }
});

test("project.stopped: jen znovuzapnutí, nic jiného", () => {
  // 'stopped' NENÍ terminální — dashboard ho odjakživa nabízí znovu zapnout
  // (PauseResumeButton bere stopped jako pauzu a cílí na 'active') a stejnou
  // cestou jede postupný rollout projektů. Tabulka tuhle realitu jen dohnala.
  assert.deepEqual(projectMachine.table.stopped, ["active"]);
  assert.equal(projectMachine.can("stopped", "active"), true);
  assert.doesNotThrow(() => projectMachine.assert("stopped", "active"));
  // ...ale žádný jiný přechod ze 'stopped' legální není.
  for (const to of ["paused", "budget_hold", "stopped"] as const) {
    assert.equal(projectMachine.can("stopped", to), false);
    assert.throws(() => projectMachine.assert("stopped", to), InvalidTransitionError);
  }
});

test("terminální stavy nedovolí žádný přechod (done/…)", () => {
  // wish.done
  assert.deepEqual(wishMachine.table.done, []);
  for (const to of ["active", "parked", "specifying", "done"] as const) {
    assert.equal(wishMachine.can("done", to), false);
    assert.throws(() => wishMachine.assert("done", to), InvalidTransitionError);
  }
  // task.done
  assert.deepEqual(taskMachine.table.done, []);
  for (const to of ["queued", "running", "judging", "failed", "parked", "done"] as const) {
    assert.equal(taskMachine.can("done", to), false);
    assert.throws(() => taskMachine.assert("done", to), InvalidTransitionError);
  }
  // attempt terminální stavy
  for (const term of ["succeeded", "rejected", "failed", "aborted"] as const) {
    assert.deepEqual(attemptMachine.table[term], []);
    assert.equal(attemptMachine.can(term, "running"), false);
    assert.throws(() => attemptMachine.assert(term, "running"), InvalidTransitionError);
  }
});

test("konkrétní legální přechody: budget_hold → active (auto-resume)", () => {
  assert.equal(projectMachine.can("budget_hold", "active"), true);
  assert.doesNotThrow(() => projectMachine.assert("budget_hold", "active"));
  assert.equal(taskMachine.can("running", "judging"), true);
  assert.equal(wishMachine.can("awaiting_spec_approval", "active"), true);
});
