/* No production exports. Tests protect scroll intent, atomic coordinate conversion and bottom detection. */

import assert from "node:assert/strict";
import test from "node:test";

import ThreadScrollMode, { type ThreadScrollMetrics } from "./thread-scroll-mode";

const SCROLL_METRICS: ThreadScrollMetrics = {
  clientHeight: 600,
  scrollHeight: 1800,
  scrollTop: -350,
};

test("thread scroll modes preserve the same top-origin offset through both conversions", () => {
  const topOriginOffset = ThreadScrollMode.toTopOriginOffset("bottom-following", SCROLL_METRICS);
  assert.equal(topOriginOffset, 850);
  assert.equal(ThreadScrollMode.scrollTopForTopOriginOffset("reading", topOriginOffset, SCROLL_METRICS), 850);
  assert.equal(ThreadScrollMode.scrollTopForTopOriginOffset("bottom-following", topOriginOffset, SCROLL_METRICS), -350);
});

test("thread scroll modes convert the normal bottom into the reverse origin", () => {
  const bottomMetrics = {
    ...SCROLL_METRICS,
    scrollTop: 1200,
  };
  const topOriginOffset = ThreadScrollMode.toTopOriginOffset("reading", bottomMetrics);
  assert.equal(topOriginOffset, 1200);
  assert.equal(ThreadScrollMode.scrollTopForTopOriginOffset("bottom-following", topOriginOffset, bottomMetrics), 0);
  assert.equal(ThreadScrollMode.isAtBottom("reading", bottomMetrics), true);
  assert.equal(ThreadScrollMode.isAtBottom("bottom-following", { ...bottomMetrics, scrollTop: 0 }), true);
});

test("thread scroll modes clamp offsets when viewport dimensions change", () => {
  const shorterMetrics = {
    clientHeight: 600,
    scrollHeight: 1000,
    scrollTop: 0,
  };
  assert.equal(ThreadScrollMode.scrollTopForTopOriginOffset("reading", 850, shorterMetrics), 400);
  assert.equal(ThreadScrollMode.scrollTopForTopOriginOffset("bottom-following", -100, shorterMetrics), -400);
});

test("thread scroll bottom detection keeps a one-pixel transition tolerance", () => {
  assert.equal(ThreadScrollMode.isAtBottom("reading", { ...SCROLL_METRICS, scrollTop: 1199 }), true);
  assert.equal(ThreadScrollMode.isAtBottom("reading", { ...SCROLL_METRICS, scrollTop: 1198.9 }), false);
  assert.equal(ThreadScrollMode.isAtBottom("bottom-following", { ...SCROLL_METRICS, scrollTop: -1 }), true);
  assert.equal(ThreadScrollMode.isAtBottom("bottom-following", { ...SCROLL_METRICS, scrollTop: -1.1 }), false);
});

test("passive geometry changes do not impersonate movement away from bottom", () => {
  const atBottom: ThreadScrollMetrics = {
    clientHeight: 600,
    scrollHeight: 600,
    scrollTop: 0,
  };

  assert.equal(ThreadScrollMode.didMoveAwayFromBottom("bottom-following", atBottom, {
    clientHeight: 600,
    scrollHeight: 900,
    scrollTop: -300,
  }), false, "content growth");
  assert.equal(ThreadScrollMode.didMoveAwayFromBottom("bottom-following", SCROLL_METRICS, {
    clientHeight: 600,
    scrollHeight: 1_200,
    scrollTop: -50,
  }), false, "content shrinkage");
  assert.equal(ThreadScrollMode.didMoveAwayFromBottom("bottom-following", SCROLL_METRICS, {
    clientHeight: 700,
    scrollHeight: 1_800,
    scrollTop: -250,
  }), false, "viewport resize");
});

test("only stable-geometry movement farther from bottom counts as reading intent", () => {
  assert.equal(ThreadScrollMode.didMoveAwayFromBottom("bottom-following", {
    ...SCROLL_METRICS,
    scrollTop: 0,
  }, {
    ...SCROLL_METRICS,
    scrollTop: -120,
  }), true);
  assert.equal(ThreadScrollMode.didMoveAwayFromBottom("bottom-following", SCROLL_METRICS, {
    ...SCROLL_METRICS,
    scrollTop: -200,
  }), false, "movement toward bottom");
});
