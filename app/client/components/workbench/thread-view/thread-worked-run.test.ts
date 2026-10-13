/*
 * No exports. Tests protect worked-run age, geometry and user reveal transitions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  admitSettledItems, canCollapseWorkedRun, reconcileWorkedRun, revealWorkedRun, workedRunReadyAt, type WorkedRunGate,
} from "./thread-worked-run";

const turn = (id: string, ...items: string[]) => ({ id, items: items.map(item => ({ id: item })) });

test("history arriving later is settled on arrival, while a turn that finishes in view keeps its state", () => {
  const opened = admitSettledItems(null, [turn("old", "a"), turn("live", "b")], "live");
  assert.deepEqual([...opened.settled], ["a"]);
  const paged = admitSettledItems(opened, [turn("older", "z"), turn("old", "a"), turn("live", "b", "c")], null);
  assert.deepEqual([...paged.settled].sort(), ["a", "z"]);
  assert.equal(admitSettledItems(paged, [turn("older", "z"), turn("old", "a"), turn("live", "b", "c")], null), paged);
});

const gate: WorkedRunGate = { count: 5, newestActivityAt: 100, initialInactive: false, above: true, now: 1_800_101 };

test("whole old runs collapse only above the viewport with at least three rendered rows", () => {
  assert.equal(canCollapseWorkedRun(gate), true);
  assert.equal(canCollapseWorkedRun({ ...gate, count: 3 }), true);
  assert.equal(canCollapseWorkedRun({ ...gate, count: 2 }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, above: false }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, now: 1_800_100 }), false);
  assert.equal(canCollapseWorkedRun({ ...gate, newestActivityAt: null }), false);
});

test("initial inactive content bypasses age but never geometry or row count", () => {
  const initial = { ...gate, initialInactive: true, newestActivityAt: null };
  assert.equal(canCollapseWorkedRun(initial), true);
  assert.equal(canCollapseWorkedRun({ ...initial, above: false }), false);
  assert.equal(canCollapseWorkedRun({ ...initial, count: 3 }), true);
  assert.equal(canCollapseWorkedRun({ ...initial, count: 2 }), false);
  assert.equal(canCollapseWorkedRun({ ...initial, initialInactive: false }), false);
  assert.equal(workedRunReadyAt(initial), 0);
  assert.equal(workedRunReadyAt({ ...initial, initialInactive: false }), null);
});

test("revealed content stays revealed through history scrolling until bottom reattachment", () => {
  assert.equal(reconcileWorkedRun("expanded", gate, "geometry"), "collapsed");
  const revealed = revealWorkedRun();
  assert.equal(reconcileWorkedRun(revealed, gate, "geometry"), revealed);
  assert.equal(reconcileWorkedRun(revealed, { ...gate, above: false }, "geometry"), revealed);
  assert.equal(reconcileWorkedRun(revealed, gate, "geometry"), revealed);
  const attached = reconcileWorkedRun(revealed, gate, "bottomReattached");
  assert.equal(attached, "expanded");
  assert.equal(reconcileWorkedRun(attached, gate, "geometry"), "collapsed");
});

test("newer activity postpones eligibility instead of inheriting an old run age", () => {
  assert.equal(canCollapseWorkedRun(gate), true);
  assert.equal(canCollapseWorkedRun({ ...gate, newestActivityAt: gate.now }), false);
  assert.equal(reconcileWorkedRun("collapsed", { ...gate, newestActivityAt: gate.now }, "geometry"), "expanded");
  assert.equal(reconcileWorkedRun("collapsed", { ...gate, above: false }, "geometry"), "collapsed");
});
