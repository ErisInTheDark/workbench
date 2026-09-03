/* No production exports. Tests protect provider-shaped unified-diff parsing. */
import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "./thread-file-diff";

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
