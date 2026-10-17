/*
 * No exports. Wards for the suggestion syntax: a `<del>` block pairs only with an `<ins>` block right after it, either
 * side may be absent, and a closing tag inside a code fence is content.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatSuggestion, readSuggestionBlock } from "./markdown-suggestion";

function read(markdown: string) {
  return readSuggestionBlock(markdown.split("\n"), 0);
}

test("written suggestions read back as the same replacement", () => {
  for (const suggestion of [{ old: "a\n\nb", new: "c" }, { old: "gone", new: "" }, { old: "", new: "- added" }]) {
    assert.deepEqual(read(formatSuggestion(suggestion))?.suggestion, suggestion);
  }
});

test("an insertion pairs with a deletion only directly after it", () => {
  assert.deepEqual(read("<del>\nold\n</del>\n\n<ins>\nnew\n</ins>")?.suggestion, { old: "old", new: "" });
});

test("closing tags inside code fences are content", () => {
  assert.deepEqual(read("<del>\n```\n</del>\n```\n</del>")?.suggestion, { old: "```\n</del>\n```", new: "" });
});

test("an unclosed tag is not a suggestion", () => {
  assert.equal(read("<del>\nnever closed"), null);
});
