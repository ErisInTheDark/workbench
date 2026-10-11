/*
 * No exports. Tests protect bounded progressive transcript prepends near the window's top.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadProgressiveWindowController, {
  type ProgressiveWindowView,
} from "./ThreadProgressiveWindowController";

function fixture({ deferReveal = false } = {}) {
  const identity = {};
  const viewport = {};
  let hiddenCount = 12;
  let nearTop = true;
  const reveals: number[] = [];
  const controller = new ThreadProgressiveWindowController({
    readView: (): ProgressiveWindowView => ({ hiddenCount, identity, nearTop, viewport }),
    reveal: count => {
      reveals.push(count);
      if (!deferReveal) hiddenCount -= count;
    },
  });
  return {
    controller,
    reveals,
    commitReveal() { hiddenCount -= reveals.at(-1) ?? 0; },
    setNearTop(value: boolean) { nearTop = value; },
  };
}

test("reveals one bounded batch, and stops once the reader is away from the top", () => {
  const f = fixture();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4]);

  f.setNearTop(false);
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4]);
});

test("short windows keep filling while the reader is still near the top", () => {
  const f = fixture();
  f.controller.reconcile();
  f.controller.reconcile();
  f.controller.reconcile();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4, 4, 4]);
});

test("repeated notifications cannot reveal again before React commits the prepend", () => {
  const f = fixture({ deferReveal: true });
  f.controller.reconcile();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4]);

  f.commitReveal();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4, 4]);
});
