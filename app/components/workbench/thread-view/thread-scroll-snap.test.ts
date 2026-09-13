/*
 * No production exports. Tests protect initial placement, scroll direction, end detection, and normal-flow layout preservation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getInitialThreadScrollTop,
  getPreservedThreadScrollTop,
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
} from "./thread-scroll-snap";

test("initial placement waits for the committed thread end target", () => {
  assert.equal(getInitialThreadScrollTop(false, 1_800), null);
  assert.equal(getInitialThreadScrollTop(true, 1_800), 1_800);
});

test("thread scroll direction follows movement and ignores unchanged offsets", () => {
  assert.equal(resolveThreadScrollDirection("up", 40, 80), "down");
  assert.equal(resolveThreadScrollDirection("down", 80, 40), "up");
  assert.equal(resolveThreadScrollDirection("up", 40, 40), "up");
});

test("thread end detection uses the normal top-origin boundary", () => {
  const metrics = {
    clientHeight: 600,
    scrollHeight: 1_800,
    scrollTop: 1_199,
  };
  assert.equal(isThreadScrollAtEnd(metrics), true);
  assert.equal(isThreadScrollAtEnd({ ...metrics, scrollTop: 1_198.9 }), false);
});

test("offscreen layout changes preserve the reader position", () => {
  assert.equal(getPreservedThreadScrollTop(
    { clientHeight: 600, scrollHeight: 1_800, scrollTop: 500 },
    { clientHeight: 600, scrollHeight: 2_200, scrollTop: 500 },
  ), 900);
  assert.equal(getPreservedThreadScrollTop(
    { clientHeight: 600, scrollHeight: 1_800, scrollTop: 500 },
    { clientHeight: 600, scrollHeight: 900, scrollTop: 500 },
  ), 0);
});

test("snapped layout changes stay owned by native re-snapping", () => {
  assert.equal(getPreservedThreadScrollTop(
    { clientHeight: 600, scrollHeight: 1_800, scrollTop: 1_200 },
    { clientHeight: 600, scrollHeight: 2_200, scrollTop: 1_200 },
  ), null);
});
