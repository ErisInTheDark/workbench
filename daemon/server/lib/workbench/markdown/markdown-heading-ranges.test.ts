/* Exports: none. Tests protect structured ATX heading ranges and Markdown exclusion boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listMarkdownHeadingRangeLines,
  listMarkdownHeadingRanges,
} from "./markdown-heading-ranges";

test("lists hierarchy-aware ranges for ATX headings of any depth", () => {
  const markdown = [
    "## Parent",
    "body",
    "### Child",
    "child body",
    "####### Deep",
    "deep body",
    "### Sibling",
    "sibling body",
    "###nospace",
    "    #### indented code",
    "########",
    "## Next",
  ].join("\n").concat("\n");

  assert.deepEqual(listMarkdownHeadingRangeLines(markdown), [
    "1-11 ## Parent",
    "3-6 ### Child",
    "5-6 ####### Deep",
    "7-11 ### Sibling",
    "11-11 ########",
    "12-12 ## Next",
  ]);
  const ranges = listMarkdownHeadingRanges(markdown);
  assert.deepEqual(ranges.map(({ endLine, level, source, startLine }) => ({
    endLine, level, source, startLine,
  })), [
    { endLine: 11, level: 2, source: "## Parent", startLine: 1 },
    { endLine: 6, level: 3, source: "### Child", startLine: 3 },
    { endLine: 6, level: 7, source: "####### Deep", startLine: 5 },
    { endLine: 11, level: 3, source: "### Sibling", startLine: 7 },
    { endLine: 11, level: 8, source: "########", startLine: 11 },
    { endLine: 12, level: 2, source: "## Next", startLine: 12 },
  ]);
  assert.equal(
    markdown.slice(ranges[1].startOffset, ranges[1].endOffset),
    ["### Child", "child body", "####### Deep", "deep body", ""].join("\n"),
  );
});

test("ignores headings inside fenced code and HTML comments", () => {
  const markdown = [
    "# Real",
    "text <!--",
    "## hidden by trailing comment opener",
    "-->",
    "## Visible",
    "~~~",
    "<!--",
    "# hidden in tilde fence",
    "~~~",
    "### After tilde",
    "```md",
    "## hidden in backtick fence",
    "```",
    "<!-- #### hidden on one line -->",
    "<!--",
    "#### hidden in block comment",
    "-->",
    "### Visible child <!--",
    "#### hidden after heading opens comment",
    "-->",
    "#### Visible deep",
    "inline code does not open a comment: `<!--`",
    "##### Visible after inline code",
    "tail <!--",
    "###### hidden in unclosed comment",
  ].join("\n");

  assert.deepEqual(listMarkdownHeadingRangeLines(markdown), [
    "1-25 # Real",
    "5-25 ## Visible",
    "10-17 ### After tilde",
    "18-25 ### Visible child <!--",
    "21-25 #### Visible deep",
    "23-25 ##### Visible after inline code",
  ]);
});
