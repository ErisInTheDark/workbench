/*
 * No production exports. Regression wards protect copy-enabled plan summaries and embedded marker integration. Keywords: thread, plan, summary, copy, renderer, icon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadPayload } from "workbench-shared/types";
import { renderThreadMarkdown } from "./thread-markdown-render";
import { ThreadThreadContent } from "./thread-view-items";
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

test("first-class plan items use the shared copy-enabled summary", () => {
  const thread = {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    createdAt: 1,
    cwd: "C:/workspace",
    forkedFromId: null,
    harness: "codex",
    id: "thread-plan-summary",
    isDraft: false,
    model: null,
    name: null,
    path: null,
    preview: "",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: "completed",
    tokenUsage: null,
    turnHistory: [],
    turns: [{
      completedAt: 2,
      durationMs: 1000,
      error: null,
      id: "turn-plan-summary",
      items: [{ id: "plan-item", text: "## first-class plan marker", type: "plan" }],
      itemsView: "full",
      startedAt: 1,
      status: "completed",
    }],
    updatedAt: 2,
  } satisfies ThreadPayload;
  const html = renderToStaticMarkup(createElement(ThreadThreadContent, {
    defaultOpenCompletedWork: true,
    thread,
  }));

  assert.match(html, />Plan</u);
  assert.match(html, /aria-label="Copy plan"/u);
  assert.equal(countMatches(html, /data-thread-plan-copy="true"/gu), 1);
});
