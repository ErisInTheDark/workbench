/*
 * No production exports. Node tests protect the sticky composer's near-bottom release and separate geometric thresholds. Keywords: sticky, collapsible, hysteresis, viewport, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStickyCollapsiblePlacement } from "./sticky-collapsible-state";

test("an inline composer stays inline while its source slot remains visible", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "inline",
    inlineSlotTop: 719,
    isNearScrollBottom: false,
    scrollTargetBottom: 720,
    stickyComposerTop: null,
    viewportBottom: 844,
  }), "inline");
});

test("an inline composer moves sticky once its source slot leaves the visible scrollport", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "inline",
    inlineSlotTop: 720,
    isNearScrollBottom: false,
    scrollTargetBottom: 720,
    stickyComposerTop: null,
    viewportBottom: 844,
  }), "sticky");
});

test("the visual viewport can provide the inline entry boundary", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "inline",
    inlineSlotTop: 560,
    isNearScrollBottom: false,
    scrollTargetBottom: 844,
    stickyComposerTop: null,
    viewportBottom: 560,
  }), "sticky");
});

test("a sticky composer stays sticky while its source slot remains below the composer top", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "sticky",
    inlineSlotTop: 500,
    isNearScrollBottom: false,
    scrollTargetBottom: 720,
    stickyComposerTop: 420,
    viewportBottom: 844,
  }), "sticky");
});

test("a sticky composer returns inline when its source slot crosses above the composer top", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "sticky",
    inlineSlotTop: 420,
    isNearScrollBottom: false,
    scrollTargetBottom: 720,
    stickyComposerTop: 420,
    viewportBottom: 844,
  }), "inline");
});

test("exit geometry does not also satisfy the inline entry threshold", () => {
  const inlineSlotTop = 420;
  const scrollTargetBottom = 720;
  const viewportBottom = 844;
  const stickyComposerTop = 420;

  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "sticky",
    inlineSlotTop,
    isNearScrollBottom: false,
    scrollTargetBottom,
    stickyComposerTop,
    viewportBottom,
  }), "inline");
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "inline",
    inlineSlotTop,
    isNearScrollBottom: false,
    scrollTargetBottom,
    stickyComposerTop: null,
    viewportBottom,
  }), "inline");
});

test("near-bottom scroll returns a sticky composer inline before the geometric exit", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "sticky",
    inlineSlotTop: 500,
    isNearScrollBottom: true,
    scrollTargetBottom: 720,
    stickyComposerTop: 420,
    viewportBottom: 844,
  }), "inline");
});

test("near-bottom scroll keeps an inline composer from entering sticky placement", () => {
  assert.equal(resolveStickyCollapsiblePlacement({
    currentPlacement: "inline",
    inlineSlotTop: 720,
    isNearScrollBottom: true,
    scrollTargetBottom: 720,
    stickyComposerTop: null,
    viewportBottom: 844,
  }), "inline");
});
