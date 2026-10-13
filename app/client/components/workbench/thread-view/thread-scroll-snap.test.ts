/*
 * No production exports. Tests protect initial placement, wheel/pointer/touch direction, proximity, and bottom reattachment.
 */

import assert from "node:assert/strict";
import { didThreadScrollReattach } from "./thread-scroll-snap";
import test from "node:test";

import {
  getInitialThreadScrollTop,
  isThreadScrollAtEnd,
  resolveThreadScrollDirection,
  resolveThreadScrollProximity,
  resolveThreadTouchScrollDirection,
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

test("thread touch direction translates finger travel into viewport movement", () => {
  assert.equal(resolveThreadTouchScrollDirection("down", 80, 120), "up");
  assert.equal(resolveThreadTouchScrollDirection("up", 120, 80), "down");
  assert.equal(resolveThreadTouchScrollDirection("up", 80, 80), "up");
});

test("thread scroll proximity becomes near only at the true bottom", () => {
  const metrics = {
    clientHeight: 600,
    scrollHeight: 1_800,
    scrollTop: 1_199,
  };
  assert.equal(resolveThreadScrollProximity(metrics), "near");
  assert.equal(resolveThreadScrollProximity({ ...metrics, scrollTop: 1_198.9 }), "far");
  assert.equal(resolveThreadScrollProximity({ ...metrics, scrollTop: 1_100 }), "far");
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

test("bottom reattachment requires reaching the end after leaving it", () => {
  const end = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
  assert.equal(didThreadScrollReattach(false, end), true);
  assert.equal(didThreadScrollReattach(true, end), false);
  assert.equal(didThreadScrollReattach(false, { ...end, scrollTop: 800 }), false);
});

test("an inset end target attaches without reaching the physical scroll limit", () => {
  const end = { scrollTop: 884, scrollHeight: 1000, clientHeight: 100, endOffsetPx: 16 };
  assert.equal(isThreadScrollAtEnd(end), true);
  assert.equal(resolveThreadScrollProximity(end), "near");
  assert.equal(didThreadScrollReattach(false, end), true);
  assert.equal(isThreadScrollAtEnd({ ...end, scrollTop: 882 }), false);
  assert.equal(isThreadScrollAtEnd({ ...end, scrollTop: 900 }), true);
  assert.equal(isThreadScrollAtEnd({ ...end, endOffsetPx: 0 }), false);
});
