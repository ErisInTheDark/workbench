/*
 * No production exports. Regression wards protect copy-enabled plan summaries and inline plan markers. Keywords: thread, plan, summary, copy, renderer, icon, alert.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadPayload } from "../../../lib/types";
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
    renderThreadMarkdown('<plan>\n## <icon type="alert" color="blue" /> embedded plan marker\n</plan>'),
  ));

  assert.match(html, /embedded plan marker/u);
  assert.match(html, /data-thread-inline-icon="alert"/u);
  assert.match(html, /data-thread-inline-icon-color="blue"/u);
  assert.match(html, /aria-label="Copy plan"/u);
  assert.equal(countMatches(html, /data-thread-plan-copy="true"/gu), 1);
});

test("thread markdown renders alert markers with the documented light and dark colors", () => {
  const colorClasses = {
    blue: "text-sky-600 dark:text-sky-300",
    green: "text-emerald-600 dark:text-emerald-300",
    purple: "text-violet-600 dark:text-violet-300",
    red: "text-red-600 dark:text-red-300",
    yellow: "text-amber-600 dark:text-amber-300",
  } as const;
  const markdown = Object.keys(colorClasses)
    .map((color) => `<icon type="alert" color="${color}" /> ${color}`)
    .join("\n\n");
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(markdown)));

  for (const [color, className] of Object.entries(colorClasses)) {
    const [lightClass, darkClass] = className.split(" ");
    assert.ok(lightClass && darkClass);
    assert.match(html, new RegExp(`class="[^"]*${lightClass}[^"]*${darkClass}[^"]*" data-thread-inline-icon="alert" data-thread-inline-icon-color="${color}"`, "u"));
  }
  assert.equal(countMatches(html, /data-thread-inline-icon="alert"/gu), 5);
  assert.equal(countMatches(html, /<circle cx="12" cy="12" r="10"><\/circle>/gu), 5);
});

test("thread markdown leaves unsupported and malformed icon markers visible", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<icon type="future" color="blue" /> unsupported type',
    '<icon type="alert" color="orange" /> unsupported color',
    '<icon color="blue" type="alert" /> malformed order',
    '`<icon type="alert" color="blue" />` code span',
  ].join("\n\n"))));

  assert.match(html, /&lt;icon type=&quot;future&quot; color=&quot;blue&quot; \/&gt; unsupported type/u);
  assert.match(html, /&lt;icon type=&quot;alert&quot; color=&quot;orange&quot; \/&gt; unsupported color/u);
  assert.match(html, /&lt;icon color=&quot;blue&quot; type=&quot;alert&quot; \/&gt; malformed order/u);
  assert.match(html, /<code[^>]*>&lt;icon type=&quot;alert&quot; color=&quot;blue&quot; \/&gt;<\/code> code span/u);
  assert.doesNotMatch(html, /data-thread-inline-icon=/u);
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
