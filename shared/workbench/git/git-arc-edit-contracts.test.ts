/* No production exports. Wards for the edit session text format: changed lines survive compaction, and older text still parses. */
import assert from "node:assert/strict";
import test from "node:test";

import { formatGitArcEditText, parseGitArcEditText, type GitArcEditResult } from "./git-arc-edit-contracts.ts";

const result: GitArcEditResult = {
  additions: 6, blockedDirtyPaths: [], blockedPendingPaths: [], claimedCount: 2, collisions: [], conflictedPaths: [],
  deletions: 2, diffs: [], fileCount: 1,
  files: [{ additions: 6, binary: false, deletions: 2, ignored: false, lines: [1, 2, 3, 5, 9, 10], path: "src/a.ts" }],
  ignoredFileCount: 0, page: 1, pageCount: 1, phase: "applied", releasedCount: 0, session: "abc12345", skippedFileCount: 0, warnings: [],
};

test("formatted edit results parse back to the same facts", () => {
  assert.deepEqual(parseGitArcEditText(formatGitArcEditText(result)), result);
});

test("older text listing claimed and released paths parses them as counts", () => {
  const legacy = [
    "arc edit reverted abc12345", "totals 0 +0 -0", "page 1/1", "files 0",
    "claimed 2", "src/a.ts", "src/b.ts", "released 1", "src/a.ts", "end edit",
  ].join("\n");
  const parsed = parseGitArcEditText(legacy);
  assert.equal(parsed?.claimedCount, 2);
  assert.equal(parsed?.releasedCount, 1);
});
