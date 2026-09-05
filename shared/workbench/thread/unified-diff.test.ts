/* No production exports. Tests protect provider-shaped unified-diff parsing. */
import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "./unified-diff.ts";

test("compact streaming hunks count changes without inventing line numbers", () => {
  const parsed = parseUnifiedDiff("@@\n-old line\n+new line\n+another line");

  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);
  assert.deepEqual(parsed.hunks[0]?.lines.map((line) => ({
    newLineNumber: line.newLineNumber,
    oldLineNumber: line.oldLineNumber,
    type: line.type,
  })), [
    { newLineNumber: null, oldLineNumber: null, type: "deletion" },
    { newLineNumber: null, oldLineNumber: null, type: "addition" },
    { newLineNumber: null, oldLineNumber: null, type: "addition" },
  ]);
});

test("only complete numbered hunks can support file observations", () => {
  const complete = parseUnifiedDiff("@@ -4,2 +4,2 @@\n anchor\n-old\n+new\n").hunks[0]!;
  assert.equal(complete.complete, true);
  assert.deepEqual([complete.oldStart, complete.oldCount, complete.newStart, complete.newCount], [4, 2, 4, 2]);
  assert.equal(parseUnifiedDiff("@@ -4,2 +4,2 @@\n anchor\n-old\n").hunks[0]?.complete, false);
  assert.equal(parseUnifiedDiff("@@\n-old\n+new\n").hunks[0]?.complete, false);
  assert.equal(parseUnifiedDiff("@@ -1 +1 @@\n-old\n+new\nunexpected\n").hunks[0]?.complete, false);
});

test("hunk content beginning with diff-header markers is still changed content", () => {
  const parsed = parseUnifiedDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n---old\n+++new\n");
  assert.equal(parsed.hunks[0]?.complete, true);
  assert.deepEqual(parsed.hunks[0]?.lines.map(({ text, type }) => ({ text, type })), [
    { text: "--old", type: "deletion" },
    { text: "++new", type: "addition" },
  ]);
});
