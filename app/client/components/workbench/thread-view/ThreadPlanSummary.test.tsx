/*
 * No production exports. Regression wards protect copy-enabled plan summaries and embedded marker integration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { renderThreadMarkdown } from "./thread-markdown-render";
import ThreadTestTurn from "./thread-view-test-render";
import ThreadPlanSummary from "./ThreadPlanSummary";

function countMatches(value: string, pattern: RegExp) {
  return Array.from(value.matchAll(pattern)).length;
}

test("plan summary renders one idle copy action without serializing its source", () => {
  const markdown = "PLAN_SOURCE_MUST_STAY_OUT_OF_THE_HEADER";
  const html = renderToStaticMarkup(createElement(ThreadPlanSummary, { markdown }));

  assert.match(html, />Plan</u);
  assert.equal(countMatches(html, /<button\b/gu), 1);
  assert.match(html, /aria-label="Copy plan"/u);
  assert.match(html, /data-thread-plan-copy-state="idle"/u);
  assert.doesNotMatch(html, new RegExp(markdown, "u"));
});

test("embedded plan markdown uses the shared copy-enabled summary", () => {
  const html = renderToStaticMarkup(createElement(
    Fragment,
    null,
    renderThreadMarkdown('<plan>\n## <icon color="blue" type="alert" /> embedded plan marker\n</plan>'),
  ));

  assert.match(html, /embedded plan marker/u);
  assert.match(html, /data-thread-inline-icon="alert"/u);
  assert.match(html, /data-thread-inline-icon-color="blue"/u);
  assert.match(html, /aria-label="Copy plan"/u);
  assert.equal(countMatches(html, /data-thread-plan-copy="true"/gu), 1);
});

test("native plan items do not render", () => {
  const html = renderToStaticMarkup(createElement(ThreadTestTurn, {
    threadId: "thread-plan-summary",
    turn: {
      completedAt: 2,
      durationMs: 1000,
      error: null,
      id: "turn-plan-summary",
      items: [{ id: "plan-item", text: "## first-class plan marker", type: "plan" }],
      itemsView: "full",
      startedAt: 1,
      status: "completed",
    },
  }));

  assert.doesNotMatch(html, /first-class plan marker/u);
  assert.doesNotMatch(html, /aria-label="Copy plan"/u);
  assert.equal(countMatches(html, /data-thread-plan-copy="true"/gu), 0);
});
