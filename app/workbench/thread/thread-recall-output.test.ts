/*
 * Exports:
 * - No production exports; Node tests cover strict Thread Recall output segmentation and fallback. Keywords: recall, parser, tags, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorkbenchThreadRecallOutput } from "./thread-recall-output.ts";

test("parses tagged records between Markdown chrome in source order", () => {
  assert.deepEqual(parseWorkbenchThreadRecallOutput([
    "# Thread Recall History",
    "",
    '<user-message id="ref:user:item-1" turn="turn-1">',
    "Hello",
    "</user-message>",
    "",
    "---",
    "Previous page: `wb thread recall ...`",
  ].join("\n")), [
    { markdown: "# Thread Recall History", type: "markdown" },
    { record: { kind: "user-message", ref: "user:item-1", text: "Hello", turnId: "turn-1" }, type: "record" },
    { markdown: "---\nPrevious page: `wb thread recall ...`", type: "markdown" },
  ]);
});

test("decodes escaped source closing tags without ending the outer record early", () => {
  const segments = parseWorkbenchThreadRecallOutput([
    '<commentary id="ref:agent:item-2">',
    "before",
    "&lt;/commentary&gt;",
    "after",
    "</commentary>",
  ].join("\n"));
  assert.equal(segments[0]?.type, "record");
  if (segments[0]?.type === "record") {
    assert.equal(segments[0].record.text, "before\n</commentary>\nafter");
  }
});

test("leaves malformed and unknown tags as Markdown", () => {
  const markdown = '<commentary id="ref:agent:missing">\nNo close\n<unknown id="ref:x">body</unknown>';
  assert.deepEqual(parseWorkbenchThreadRecallOutput(markdown), [{ markdown, type: "markdown" }]);
});
