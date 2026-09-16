/*
 * No production exports. Tests protect initial placement, direction, proximity, end following, and layout preservation.
 */

import assert from "node:assert/strict";
import { didThreadScrollReattach } from "./thread-scroll-snap";
import test from "node:test";

import {
  getInitialThreadScrollTop,
  getPreservedThreadScrollTop,
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
  resolveThreadEndFollowing,
  resolveThreadScrollProximity,
} from "./thread-scroll-snap";

test("initial placement waits for the committed thread end target", () => {
  assert.equal(getInitialThreadScrollTop(false, 1_800), null);
  assert.equal(getInitialThreadScrollTop(true, 1_800), 1_800);
});

test("thread scroll direction follows movement and ignores unchanged offsets", () => {
  assert.equal(resolveThreadScrollDirection("up", 40, 80, true), "down");
  assert.equal(resolveThreadScrollDirection("down", 80, 40, true), "up");
  assert.equal(resolveThreadScrollDirection("up", 40, 40, true), "up");
});

test("thread scroll direction ignores movement without explicit user ownership", () => {
  assert.equal(resolveThreadScrollDirection("down", 80, 40, false), "down");
  assert.equal(resolveThreadScrollDirection("down", 80, 40, true), "up");
});

test("thread scroll proximity becomes near only inside the bottom threshold", () => {
  const metrics = {
    clientHeight: 600,
    scrollHeight: 1_800,
    scrollTop: 721,
  };
  assert.equal(resolveThreadScrollProximity(metrics, 480), "near");
  assert.equal(resolveThreadScrollProximity({ ...metrics, scrollTop: 720 }, 480), "far");
  assert.equal(resolveThreadScrollProximity({ ...metrics, scrollTop: 719 }, 480), "far");
});

test("thread end following arms near the bottom and releases only on upward movement", () => {
  assert.equal(resolveThreadEndFollowing(false, "down", "far"), false);
  assert.equal(resolveThreadEndFollowing(false, "down", "near"), true);
  assert.equal(resolveThreadEndFollowing(true, "down", "far"), true);
  assert.equal(resolveThreadEndFollowing(true, "up", "near"), false);
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
test("bottom reattachment requires reaching the end after leaving it", () => {
  const end = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
  assert.equal(didThreadScrollReattach(false, end), true);
  assert.equal(didThreadScrollReattach(true, end), false);
  assert.equal(didThreadScrollReattach(false, { ...end, scrollTop: 800 }), false);
});
