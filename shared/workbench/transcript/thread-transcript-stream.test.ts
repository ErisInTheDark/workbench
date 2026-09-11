/*
 * No exports. Protect incremental placement edits without retransmitting unchanged history.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTranscriptLayoutPatch, createTranscriptLayoutPatch, type TranscriptLayout } from "./thread-transcript-stream.ts";

test("layout edits preserve retained order through append, middle replacement and removal", () => {
  const initial: TranscriptLayout = {
    turns: ["a", "b"], history: ["a", "b"], segments: [],
    items: Array.from({ length: 100 }, (_, index) => ({ itemId: `item-${index}`, turnId: "a", itemIndex: index })),
  };
  const appended = { ...initial, items: [...initial.items, { itemId: "new", turnId: "b", itemIndex: 100 }] };
  const append = createTranscriptLayoutPatch(initial, appended);
  assert.equal(append.items?.values.length, 1);
  assert.equal(append.turns, undefined);
  assert.deepEqual(applyTranscriptLayoutPatch(initial, append), appended);
  const replaced = { ...appended, items: appended.items.map((item, index) => index === 50 ? { ...item, itemId: "replacement" } : item) };
  const replacement = createTranscriptLayoutPatch(appended, replaced);
  assert.equal(replacement.items?.values.length, 1);
  assert.deepEqual(applyTranscriptLayoutPatch(appended, replacement), replaced);
  const removed = { ...replaced, items: replaced.items.slice(0, -1) };
  assert.deepEqual(applyTranscriptLayoutPatch(replaced, createTranscriptLayoutPatch(replaced, removed)), removed);
});
