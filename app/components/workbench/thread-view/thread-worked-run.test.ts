/*
 * No exports. Tests protect worked-run age, geometry and user reveal transitions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canCollapseWorkedRun, reconcileWorkedRun, revealWorkedRun, workedRunReadyAt, type WorkedRunGate } from "./thread-worked-run";

const gate: WorkedRunGate = { count: 5, newestActivityAt: 100, initialInactive: false, above: true, now: 1_800_101 };

test("whole old runs collapse only above the viewport with five rendered rows", () => {
  assert.equal(canCollapseWorkedRun(gate), true);
  assert.equal(canCollapseWorkedRun({ ...gate, count: 4 }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, above: false }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, now: 1_800_100 }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, newestActivityAt: null }), false);
});

test("initial inactive content bypasses age but never geometry or row count", () => {
  const initial = { ...gate, initialInactive: true, newestActivityAt: null };
  assert.equal(canCollapseWorkedRun(initial), true);
  assert.equal(canCollapseWorkedRun({ ...initial, above: false }), false);
  assert.equal(canCollapseWorkedRun({ ...initial, count: 4 }), false);
  assert.equal(canCollapseWorkedRun({ ...initial, initialInactive: false }), false);
  assert.equal(workedRunReadyAt(initial), 0);
  assert.equal(workedRunReadyAt({ ...initial, initialInactive: false }), null);
});

test("revealed content must become visible before it can collapse again above", () => {
  assert.equal(reconcileWorkedRun("expanded", gate, false), "collapsed");
  const revealed = revealWorkedRun();
  assert.equal(reconcileWorkedRun(revealed, gate, false), "awaitingVisible");
  const visible = reconcileWorkedRun(revealed, { ...gate, above: false }, true);
  assert.equal(visible, "expanded");
  assert.equal(reconcileWorkedRun(visible, gate, false), "collapsed");
});

test("newer activity postpones eligibility instead of inheriting an old run age", () => {
  assert.equal(canCollapseWorkedRun(gate), true);
  assert.equal(canCollapseWorkedRun({ ...gate, newestActivityAt: gate.now }), false);
  assert.equal(reconcileWorkedRun("collapsed", { ...gate, newestActivityAt: gate.now }, false), "expanded");
  assert.equal(reconcileWorkedRun("collapsed", { ...gate, above: false }, true), "collapsed");
});
