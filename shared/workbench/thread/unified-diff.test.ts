/* No production exports. Tests protect provider-shaped unified-diff parsing. */
import assert from "node:assert/strict";
import test from "node:test";

import { isBinaryGitDiff, parseUnifiedDiff } from "./unified-diff.ts";

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

test("git binary diffs parse as binary without counting their payload", () => {
  const header = "diff --git a/app.exe b/app.exe\nnew file mode 100755\nindex 0000000..1234567\n";
  for (const diff of [
    `${header}Binary files /dev/null and b/app.exe differ\n`,
    `${header}GIT binary patch\nliteral 6\nNcmZQzWMXDu0003D00961\n\nliteral 0\nHcmV?d00001\n`,
  ]) {
    const parsed = parseUnifiedDiff(diff);
    assert.equal(isBinaryGitDiff(diff), true);
    assert.equal(parsed.binary, true);
    assert.deepEqual([parsed.additions, parsed.deletions, parsed.hunks.length], [0, 0, 0]);
  }
  const text = "diff --git a/notes.md b/notes.md\n@@ -0,0 +1,2 @@\n+Binary files a/x and b/x differ\n GIT binary patch\n";
  assert.equal(isBinaryGitDiff(text), false);
  assert.equal(parseUnifiedDiff(text).binary, false);
  assert.equal(parseUnifiedDiff(text).additions, 1);
});
