/*
 * No exports. Tests protect bounded progressive transcript prepends while the reader nears or has passed the window's top.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadProgressiveWindowController, {
  type ProgressiveWindowView,
} from "./ThreadProgressiveWindowController";

const VIEWPORT_HEIGHT = 800;

function fixture({ deferReveal = false } = {}) {
  const identity = {};
  const viewport = {};
  let hiddenCount = 40;
  // Sentinel bottom relative to the viewport's top edge; negative is above it.
  let sentinelBottom = -100;
  const reveals: number[] = [];
  const controller = new ThreadProgressiveWindowController({
    readView: (): ProgressiveWindowView => ({
      hiddenCount, identity, sentinelBottom, viewport, viewportHeight: VIEWPORT_HEIGHT, viewportTop: 0,
    }),
    reveal: count => {
      reveals.push(count);
      if (!deferReveal) hiddenCount -= count;
    },
  });
  return {
    controller,
    reveals,
    commitReveal() { hiddenCount -= reveals.at(-1) ?? 0; },
    setSentinelBottom(value: number) { sentinelBottom = value; },
  };
}

test("reveals bounded batches ahead of the reader, and stops once the reader is far from the top", () => {
  const f = fixture();
  f.controller.reconcile();
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4, 4]);

  f.setSentinelBottom(-3 * VIEWPORT_HEIGHT);
  f.controller.reconcile();
  assert.deepEqual(f.reveals, [4, 4]);
});

test("a window the reader is looking at or has scrolled past keeps filling in larger batches until whole", () => {
  const f = fixture();
  f.setSentinelBottom(VIEWPORT_HEIGHT * 2);
  for (let index = 0; index < 5; index += 1) f.controller.reconcile();
  assert.deepEqual(f.reveals, [16, 16, 8]);
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
