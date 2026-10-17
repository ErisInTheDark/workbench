/*
 * No exports. Wards for the suggestion word diff: unchanged words are never marked, and changed words are marked whole.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diffWords } from "./text-diff";

function marked(text: string, spans: ReadonlyArray<{ start: number; end: number }>) {
  return spans.map(({ start, end }) => text.slice(start, end));
}

test("only changed words are marked on each side", () => {
  const before = "The original sentence was rather plain.";
  const after = "The rewritten sentence sparkles a lot more.";
  const diff = diffWords(before, after);
  assert.deepEqual(marked(before, diff.deleted), ["original", "was rather plain"]);
  assert.deepEqual(marked(after, diff.inserted), ["rewritten", "sparkles a lot more"]);
});

test("identical text marks nothing and empty sides mark everything", () => {
  assert.deepEqual(diffWords("same words", "same words"), { deleted: [], inserted: [] });
  assert.deepEqual(marked("new text", diffWords("", "new text").inserted), ["new text"]);
});
