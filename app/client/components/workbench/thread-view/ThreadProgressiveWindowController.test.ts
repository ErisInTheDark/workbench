/*
 * No exports. Tests protect progressive transcript prepends and pre-paint reading-anchor restoration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadProgressiveWindowController, {
  type ProgressiveWindowView,
} from "./ThreadProgressiveWindowController";

function fixture({ deferReveal = false } = {}) {
  const identity = {};
  const viewport = {};
  let anchorTop = 40;
  let hiddenCount = 12;
  let nearTop = true;
  let scrollTop = 300;
  const reveals: number[] = [];
  const writes: number[] = [];
  const controller = new ThreadProgressiveWindowController({
    readView: (): ProgressiveWindowView => ({
      anchor: { id: "first-visible", top: anchorTop },
      anchorTop: () => anchorTop,
      hiddenCount,
      identity,
      nearTop,
      scrollTop,
      viewport,
    }),
    reveal: count => {
      reveals.push(count);
      if (!deferReveal) hiddenCount -= count;
    },
    writeScrollTop: value => {
      writes.push(value);
      scrollTop = value;
    },
  });
  return {
    controller,
    reveals,
    writes,
    commitReveal() { hiddenCount -= reveals.at(-1) ?? 0; },
    moveAnchorBy(value: number) { anchorTop += value; },
    setNearTop(value: boolean) { nearTop = value; },
  };
}

test("reveals one bounded batch and restores the prior reading anchor before continuing", () => {
  const f = fixture();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4]);
  assert.deepEqual(f.writes, []);

  f.moveAnchorBy(640);
  f.setNearTop(false);
  f.controller.reconcile();
  assert.deepEqual(f.writes, [940]);
  assert.deepEqual(f.reveals, [4]);
});

test("short windows can keep filling without carrying a stale anchor", () => {
  const f = fixture();
  f.controller.reconcile();
  f.moveAnchorBy(100);
  f.controller.reconcile();
  assert.deepEqual(f.writes, [400]);
  assert.deepEqual(f.reveals, [4, 4]);
});

test("repeated notifications cannot consume an anchor before React commits the prepend", () => {
  const f = fixture({ deferReveal: true });
  f.controller.reconcile();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4]);

  f.commitReveal();
  f.moveAnchorBy(200);
  f.setNearTop(false);
  f.controller.reconcile();
  assert.deepEqual(f.writes, [500]);
});
