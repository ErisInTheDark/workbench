/*
 * No production exports. Node tests protect sticky collapsible geometry across nested scrollports and visual viewport clipping. Keywords: sticky, collapsible, scrollport, viewport, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isStickyCollapsibleSentinelBelowVisibleBoundary } from "./sticky-collapsible-state";

test("a sticky collapsible arms when its sentinel leaves a nested scrollport below", () => {
  assert.equal(isStickyCollapsibleSentinelBelowVisibleBoundary({
    scrollTargetBottom: 720,
    sentinelTop: 740,
    viewportBottom: 844,
  }), true);
});

test("a sticky collapsible stays inline while its sentinel remains visible", () => {
  assert.equal(isStickyCollapsibleSentinelBelowVisibleBoundary({
    scrollTargetBottom: 720,
    sentinelTop: 640,
    viewportBottom: 844,
  }), false);
});

test("the visual viewport clips a taller scrollport when the keyboard is visible", () => {
  assert.equal(isStickyCollapsibleSentinelBelowVisibleBoundary({
    scrollTargetBottom: 844,
    sentinelTop: 590,
    viewportBottom: 560,
  }), true);
});
