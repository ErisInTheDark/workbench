/* No production exports. Protect exact partial content and stale-selection rejection. */
import assert from "node:assert/strict";
import test from "node:test";
import { buildSelectedContent, describeWorkingTreeDiff } from "./working-tree-selection";

const patch = "--- a/a\n+++ b/a\n@@ -1,3 +1,4 @@\n first\n-old\n+new\n+extra\n last\n";

test("partial replacement preserves excluded edits and rejects unknown line identities", () => {
  const model = describeWorkingTreeDiff(patch);
  const selected = model.rows.filter(row => row.type === "deletion" || row.text === "new").map(row => row.id);
  const after = "first\nnew\nextra\nlast\n";
  assert.equal(buildSelectedContent("first\nold\nlast\n", patch, selected, after), "first\nnew\nlast\n");
  assert.equal(buildSelectedContent("first\nold\nlast\n", patch, [], after), "first\nold\nlast\n");
  assert.throws(() => buildSelectedContent("first\nold\nlast\n", patch, ["missing"], after), /selection/i);
  assert.throws(() => buildSelectedContent("first\nchanged\nlast\n", patch, selected, after), /base/i);
});

test("partial content preserves missing final newline and rejects incomplete patches", () => {
  const diff = "@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n";
  const ids = describeWorkingTreeDiff(diff).rows.filter(row => row.selectable).map(row => row.id);
  assert.equal(buildSelectedContent("before", diff, ids, "after"), "after");
  assert.throws(() => buildSelectedContent("before\n", "@@ -1,2 +1 @@\n-before\n+after\n", [], "after\n"), /incomplete/i);
});

test("whitespace pairing never changes selection identities", () => {
  const model = describeWorkingTreeDiff("@@ -1 +1 @@\n-old value\n+old  value\n");
  assert.equal(model.rows.filter(row => row.selectable).length, 2);
  assert.ok(model.rows.every(row => row.whitespaceOnly));
});

test("partial selection preserves the selected version's exact line endings", () => {
  const diff = "@@ -1,2 +1,2 @@\n-old\r\n+new\n keep\r\n";
  const ids = describeWorkingTreeDiff(diff).rows.filter(row => row.selectable).map(row => row.id);
  assert.equal(buildSelectedContent("old\r\nkeep\r\n", diff, ids, "new\nkeep\r\n"), "new\nkeep\r\n");
});
