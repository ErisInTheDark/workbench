/* No production exports. Protect markdown diffs marking changes in place without breaking block structure or code. */
import assert from "node:assert/strict";
import test from "node:test";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import { buildMarkdownDiff } from "./markdown-diff";

function diff(patch: string) {
  return describeWorkingTreeDiff(`--- a/doc.md\n+++ b/doc.md\n${patch}`);
}

test("an edited line marks only its changed words, keeping list and heading markers outside the marks", () => {
  const after = "# Title\n- keep the blue door\n";
  const model = diff("@@ -1,2 +1,2 @@\n # Title\n-- keep the red door\n+- keep the blue door\n");
  assert.equal(buildMarkdownDiff(after, model), "# Title\n- keep the <del>red</del><ins>blue</ins> door\n");
});

test("wholly new lines read as written and removed lines appear where they were", () => {
  const after = "intro\n- new item\noutro\n";
  assert.equal(buildMarkdownDiff(after, diff("@@ -1,2 +1,3 @@\n intro\n+- new item\n outro\n")), after);
  assert.equal(buildMarkdownDiff("Heading\n-------\n", diff("@@ -0,0 +1,2 @@\n+Heading\n+-------\n")), "Heading\n-------\n",
    "a new setext heading keeps its underline intact");
  assert.equal(buildMarkdownDiff("intro\noutro\n", diff("@@ -1,3 +1,2 @@\n intro\n-- gone item\n outro\n")),
    "intro\n- <del>gone item</del>\noutro\n");
  assert.equal(buildMarkdownDiff(after, diff("@@ -1,3 +1,3 @@\n intro\n-gone line\n+- new item\n outro\n")),
    "intro\n- <del>gone line</del><ins>new item</ins>\noutro\n", "a line changing its block kind shows wholly replaced");
});

test("changes inside a code fence stay unmarked so the code reads as written", () => {
  const after = "```\nconst a = 2;\n```\n";
  const model = diff("@@ -1,3 +1,3 @@\n ```\n-const a = 1;\n+const a = 2;\n ```\n");
  assert.equal(buildMarkdownDiff(after, model), after);
});
