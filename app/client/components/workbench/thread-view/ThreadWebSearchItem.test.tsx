/*
 * Exports:
 * - No production exports; tests protect user-owned web search disclosure state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import ThreadWebSearchItem from "./ThreadWebSearchItem";

type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

test("completed web searches leave disclosure toggles user-owned", () => {
  const item: WebSearchItem = {
    action: { queries: ["needle"], query: "needle", type: "search" },
    id: "web-search-one",
    query: "needle",
    results: null,
    type: "webSearch",
  };
  const html = renderToStaticMarkup(createElement(ThreadWebSearchItem, { item }));
  assert.doesNotMatch(html, /<details[^>]*\bopen=/u);
  const other = renderToStaticMarkup(createElement(ThreadWebSearchItem, { item: { ...item, action: { type: "other" } } }));
  assert.doesNotMatch(other, /<details[^>]*\bopen=/u);
});
