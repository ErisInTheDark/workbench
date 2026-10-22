/*
 * No exports. Tests protect that reading-position corrections never write scrollTop during touch or momentum
 * (iOS halts or ignores those): in flight they spend the reserve above the content, and at rest one scroll refills it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadScrollSettleController from "./ThreadScrollSettleController";

const CLIENT_HEIGHT = 800;

/** A scroller like a browser's: shrinking the reserve clamps scrollTop to the new bottom at once. */
function fixture(initialTarget = 0, contentHeight = 1_000_000) {
  const pending = new Set<() => void>();
  const scrolls: number[] = [];
  let offset = 0;
  let reserve = 0;
  let target = initialTarget;
  let scrollTop = 0;
  let locked = false;
  const clamp = (top: number) => Math.min(Math.max(0, top), Math.max(0, reserve + contentHeight - CLIENT_HEIGHT));
  const controller = new ThreadScrollSettleController({
    schedule: (callback) => {
      pending.add(callback);
      return () => { pending.delete(callback); };
    },
    readScrollTop: () => scrollTop,
    scrollTo: top => { scrolls.push(top - scrollTop); scrollTop = clamp(top); },
    setScrollLocked: value => { locked = value; },
    setContentOffset: value => { offset = value; },
    setReserve: value => { reserve = value; scrollTop = clamp(scrollTop); },
    readReserveTarget: () => target,
  });
  controller.reconcileReserve();
  return {
    controller,
    scrolls,
    get offset() { return offset; },
    get reserve() { return reserve; },
    setTarget(value: number) { target = value; },
    moveTo(value: number) { scrollTop = value; },
    scrollTo(value: number) { scrollTop = value; controller.scrolled(); },
    get scrollTop() { return scrollTop; },
    get locked() { return locked; },
    fling() {
      controller.touchStarted();
      controller.touchEnded();
    },
    idle() {
      const callbacks = [...pending];
      pending.clear();
      callbacks.forEach(callback => callback());
    },
  };
}

test("settled corrections scroll immediately and the reserve is filled with a matching scroll", () => {
  const f = fixture(1_000);
  f.controller.shift(120);
  assert.deepEqual(f.scrolls, [1_000, 120]);
  assert.equal(f.reserve, 1_000);
});

test("growth above the reader across back-to-back flings spends the reserve without any scroll", () => {
  const f = fixture(1_000);
  f.controller.touchStarted();
  f.controller.shift(300);
  f.idle();
  assert.equal(f.controller.settled, false, "a held finger never settles by idling");
  f.controller.touchEnded();
  f.controller.shift(-40);
  f.controller.scrolled();
  // The next fling catches the momentum before it settles.
  f.controller.touchStarted();
  f.controller.touchEnded();
  f.controller.shift(200);
  f.controller.reconcileReserve();
  assert.deepEqual(f.scrolls, [1_000]);
  assert.equal(f.reserve, 540);
  assert.equal(f.offset, 0);

  f.idle();
  assert.equal(f.controller.settled, true);
  assert.equal(f.reserve, 1_000);
  assert.deepEqual(f.scrolls, [1_000, 460], "one scroll at rest refills exactly what was spent");
});

test("growth beyond the reserve falls back to content offset and is repaid at settle", () => {
  const f = fixture(200);
  f.fling();
  f.controller.shift(500);
  assert.equal(f.reserve, 0);
  assert.equal(f.offset, -300);
  f.controller.shift(-100);
  assert.equal(f.offset, -200, "shrinking content repays the overflow first");
  assert.equal(f.reserve, 0);

  f.controller.scrollEnded();
  assert.equal(f.offset, 0);
  assert.equal(f.reserve, 200);
  assert.deepEqual(f.scrolls, [200, 400]);
});

test("the reserve is removed at rest once nothing more can arrive above", () => {
  const f = fixture(500);
  f.fling();
  f.controller.shift(50);
  f.setTarget(0);
  f.controller.reconcileReserve();
  assert.equal(f.reserve, 450, "in flight the reserve cannot be removed without a scroll");
  f.controller.scrollEnded();
  assert.equal(f.reserve, 0);
  assert.deepEqual(f.scrolls, [500, -450]);
});

test("removing the reserve keeps the reader's place even though the shorter page clamps the scroll first", () => {
  const f = fixture(1_000, 2_000);
  f.moveTo(2_100);
  f.setTarget(0);
  f.controller.reconcileReserve();
  assert.equal(f.reserve, 0);
  assert.equal(f.scrollTop, 1_100, "the reader stays 1,100px into the content");
});

test("momentum still moving behind a stalled main thread does not count as settled", () => {
  const f = fixture(500);
  f.fling();
  f.controller.shift(100);
  f.moveTo(1_200);
  f.idle();
  assert.equal(f.controller.settled, false);
  assert.deepEqual(f.scrolls, [500]);
  f.idle();
  assert.equal(f.controller.settled, true);
  assert.deepEqual(f.scrolls, [500, 100]);
});

test("momentum heading into the reserve is caught on the frame before the loaded top", () => {
  const f = fixture(1_000);
  f.moveTo(1_500);
  f.fling();
  f.scrollTo(1_300);
  assert.equal(f.locked, false);
  f.scrollTo(1_120);
  assert.equal(f.locked, true, "the next 180px frame would cross the loaded top at 1,000");
  f.idle();
  assert.equal(f.locked, false, "momentum locks release once the fling is dead");
  assert.equal(f.scrollTop, 1_120);
});

test("scrolling down away from the loaded top is never caught", () => {
  const f = fixture(1_000);
  f.moveTo(1_010);
  f.fling();
  f.scrollTo(1_100);
  assert.equal(f.locked, false);
});

test("a drag caught at the loaded top stays caught until the finger lifts", () => {
  const f = fixture(1_000);
  f.moveTo(1_050);
  f.controller.touchStarted();
  f.scrollTo(1_010);
  assert.equal(f.locked, true);
  f.idle();
  assert.equal(f.locked, true);
  f.controller.touchEnded();
  assert.equal(f.locked, false);
});

test("momentum the catch did not stop is put back at the loaded top on the scroll that crossed, not at rest", () => {
  const f = fixture(1_000);
  f.moveTo(1_200);
  f.fling();
  f.scrollTo(1_100);
  f.scrollTo(970);
  assert.equal(f.scrollTop, 1_000);
  assert.deepEqual(f.scrolls, [1_000, 30]);
  f.controller.scrollEnded();
  assert.deepEqual(f.scrolls, [1_000, 30], "nothing is left to repay at rest");
});

test("an overshoot into the reserve is brought back to the loaded top at rest", () => {
  const f = fixture(1_000);
  f.moveTo(1_200);
  f.fling();
  f.moveTo(700);
  f.controller.scrollEnded();
  assert.equal(f.scrollTop, 1_000);
  assert.deepEqual(f.scrolls, [1_000, 300]);
});

test("scroll without touch, such as wheel, is already settled", () => {
  const f = fixture();
  f.controller.scrolled();
  f.controller.scrollEnded();
  f.controller.shift(10);
  assert.deepEqual(f.scrolls, [10]);
});
