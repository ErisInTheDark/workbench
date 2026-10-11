/*
 * No exports. Tests protect that any layout change above the reader is put back exactly once, and that losing the
 * anchor re-anchors instead of guessing a correction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadReadingAnchorController from "./ThreadReadingAnchorController";

interface FakeAnchor { offset: number; connected: boolean }

function fixture() {
  const shifts: number[] = [];
  let atTop: FakeAnchor = { offset: 500, connected: true };
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    shift: delta => shifts.push(delta),
  });
  controller.record();
  return {
    controller,
    shifts,
    get anchor() { return atTop; },
    scrollTo(next: FakeAnchor) { atTop = next; controller.record(); },
  };
}

test("growth above the anchor moves the reader by exactly that growth", () => {
  const f = fixture();
  f.anchor.offset += 140;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [140]);
});

test("later ticks of the same content settling are each put back once", () => {
  const f = fixture();
  for (const growth of [112, 85, 140]) {
    f.anchor.offset += growth;
    f.controller.reconcile();
    f.controller.reconcile();
  }
  assert.deepEqual(f.shifts, [112, 85, 140]);
});

test("changes that leave the anchor's content position alone need no correction", () => {
  const f = fixture();
  f.controller.reconcile();
  assert.deepEqual(f.shifts, []);
});

test("a shrink above the reader moves them back up", () => {
  const f = fixture();
  f.anchor.offset -= 300;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [-300]);
});

test("an unmounted anchor is replaced on the next layout change without inventing a correction", () => {
  const shifts: number[] = [];
  const first = { offset: 100, connected: true };
  const second = { offset: 400, connected: true };
  let atTop = first;
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    shift: delta => shifts.push(delta),
  });
  controller.record();
  first.connected = false;
  atTop = second;
  controller.reconcile();
  second.offset += 30;
  controller.reconcile();
  assert.deepEqual(shifts, [30]);
});

test("growth the reader scrolls past before any observer reports it is still put back", () => {
  const f = fixture();
  f.anchor.offset += 50;
  f.scrollTo({ offset: 1200, connected: true });
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [50]);
});

test("scrolling re-anchors, so movement the reader made is never corrected", () => {
  const f = fixture();
  f.scrollTo({ offset: 1200, connected: true });
  f.controller.reconcile();
  assert.deepEqual(f.shifts, []);
});
