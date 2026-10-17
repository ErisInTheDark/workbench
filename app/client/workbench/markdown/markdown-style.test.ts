/*
 * No exports. Wards for file style detection: rewritten blocks follow the delimiters, bullets and line endings a file
 * already uses, and code never counts as evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentLineStyle, detectMarkdownStyle } from "./markdown-style";

test("delimiter and bullet habits follow the file", () => {
  assert.deepEqual(detectMarkdownStyle("__a__ and _b_\n\n* one\n* two\n"), {
    bullet: "*", emphasis: "_", finalNewline: true, lineEnding: "\n", listIndent: 2, orderedDelimiter: ".",
    setextHeadings: false, strong: "__",
  });
  assert.equal(detectMarkdownStyle("**a** *b* __c__ **d**").strong, "**");
});

test("heading, ordered marker and nesting habits follow the file", () => {
  const style = detectMarkdownStyle("Title\n=====\n\nPart\n----\n\n1) one\n    - nested\n2) two\n\n# atx\n");
  assert.equal(style.setextHeadings, true);
  assert.equal(style.orderedDelimiter, ")");
  assert.equal(style.listIndent, 4);
  assert.equal(detectMarkdownStyle("# a\n\n## b\n\nText\n\n---\n").setextHeadings, false, "a rule after a blank line is no underline");
});

test("code spans and fences are not evidence", () => {
  const style = detectMarkdownStyle("plain **bold**\n\n```\n__x__ __y__ __z__\n```\n\n`__w__`\n");
  assert.equal(style.strong, "**");
});

test("line endings and the final newline round-trip", () => {
  const style = detectMarkdownStyle("a\r\nb");
  assert.equal(applyDocumentLineStyle("a\nb\n", style), "a\r\nb");
});
