/*
 * Exports:
 * - No production exports; Node tests cover strict Thread Recall output segmentation and fallback. Keywords: recall, parser, tags, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkbenchThreadRecallOutput,
  summarizeWorkbenchThreadRecallOutput,
} from "./thread-recall-output.ts";

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

test("summarises captured recall records by semantic speaker group", () => {
  const summary = summarizeWorkbenchThreadRecallOutput([
    "# Thread Recall History",
    "",
    '<user-message id="ref:user:one">',
    "Question",
    "</user-message>",
    "",
    '<user-steer id="ref:user:two">',
    "Correction",
    "</user-steer>",
    "",
    '<commentary id="ref:agent:one">',
    "Progress",
    "</commentary>",
    "",
    '<plan id="ref:plan:one">',
    "Plan",
    "</plan>",
  ].join("\n"));

  assert.deepEqual(summary, {
    mode: "history",
    recordCount: 4,
    recordCounts: {
      agent: 1,
      plan: 1,
      questionnaire: 0,
      user: 2,
    },
    searchMatches: null,
  });
});

test("summarises search totals separately from records shown on the captured page", () => {
  const summary = summarizeWorkbenchThreadRecallOutput([
    "# Thread Recall Search",
    "",
    "Matches: 20 total; 1 shown on this newest-first page.",
    "",
    '<final-answer id="ref:agent:one">',
    "Match",
    "</final-answer>",
  ].join("\n"));

  assert.ok(summary);
  assert.deepEqual(summary.searchMatches, { shown: 1, total: 20 });
  assert.equal(summary.recordCount, 1);
});

test("does not invent result semantics for malformed fallback output", () => {
  assert.equal(summarizeWorkbenchThreadRecallOutput("unstructured output"), null);
  assert.equal(summarizeWorkbenchThreadRecallOutput([
    "# Thread Recall History",
    "",
    '<commentary id="ref:agent:missing">',
    "No close",
  ].join("\n")), null);
});
