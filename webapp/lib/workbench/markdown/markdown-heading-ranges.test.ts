/*
 * Exports:
 * - No production exports; tests protect ATX hierarchy ranges and Markdown exclusion boundaries. Keywords: markdown, toc, headings, ranges, fences, comments, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { listMarkdownHeadingRangeLines } from "./markdown-heading-ranges";

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
