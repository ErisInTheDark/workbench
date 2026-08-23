/*
 * No production exports. Node tests protect sticky composer geometry across nested scrollports and visual viewport clipping. Keywords: thread, composer, sticky, scrollport, viewport, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isStickyComposerSentinelBelowVisibleBoundary } from "./thread-composer-sticky-state";

test("the sticky composer arms when its sentinel leaves a nested scrollport below", () => {
  assert.equal(isStickyComposerSentinelBelowVisibleBoundary({
    scrollTargetBottom: 720,
    sentinelTop: 740,
    viewportBottom: 844,
  }), true);
});

test("the sticky composer stays inline while its sentinel remains visible", () => {
  assert.equal(isStickyComposerSentinelBelowVisibleBoundary({
    scrollTargetBottom: 720,
    sentinelTop: 640,
    viewportBottom: 844,
  }), false);
});

test("the visual viewport clips a taller scrollport when the keyboard is visible", () => {
  assert.equal(isStickyComposerSentinelBelowVisibleBoundary({
    scrollTargetBottom: 844,
    sentinelTop: 590,
    viewportBottom: 560,
  }), true);
});
