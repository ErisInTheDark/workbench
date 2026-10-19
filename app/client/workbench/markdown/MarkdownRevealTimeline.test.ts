/*
 * No production exports. Regression wards protect which visible streamed characters fade, and from when.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import MarkdownRevealTimeline, { REVEAL_DURATION_MS } from "./MarkdownRevealTimeline";

function render(timeline: MarkdownRevealTimeline, now: number, ...texts: string[]) {
  const cursor = timeline.cursor(now);
  const pieces = texts.map(text => cursor.text(text).map(piece => [piece.text, piece.startedAt]));
  timeline.commit(cursor);
  return pieces;
}

test("a settled first render does not fade, and later growth fades from when it appeared", () => {
  const timeline = new MarkdownRevealTimeline(null);
  assert.deepEqual(render(timeline, 0, "abc"), [[["abc", null]]]);
  assert.deepEqual(render(timeline, 100, "abc", "de"), [[["abc", null]], [["de", 100]]]);
  assert.deepEqual(render(timeline, 150, "abcd", "ef"), [[["abc", null], ["d", 100]], [["e", 100], ["f", 150]]]);
});

test("fades expire and shrinking text restarts from the new length without fading", () => {
  const timeline = new MarkdownRevealTimeline(null);
  render(timeline, 0, "abc");
  render(timeline, 100, "abcde");
  assert.deepEqual(render(timeline, 100 + REVEAL_DURATION_MS, "abcde"), [[["abcde", null]]]);
  assert.deepEqual(render(timeline, 400, "ab"), [[["ab", null]]]);
  assert.deepEqual(render(timeline, 450, "abX"), [[["ab", null], ["X", 450]]]);
});

test("a timeline mounted mid-stream fades everything first rendered, and atoms fade whole", () => {
  const timeline = new MarkdownRevealTimeline(0);
  const cursor = timeline.cursor(10);
  assert.equal(cursor.animates, true);
  assert.deepEqual(cursor.text("hi ").map(piece => piece.startedAt), [10]);
  assert.equal(cursor.atom(4), 10);
  timeline.commit(cursor);

  const next = timeline.cursor(10 + REVEAL_DURATION_MS);
  next.text("hi ");
  assert.equal(next.atom(4), null);
  assert.equal(next.atom(), 10 + REVEAL_DURATION_MS);
});
