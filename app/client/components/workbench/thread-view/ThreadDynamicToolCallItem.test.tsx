/*
 * Exports:
 * - No production exports; tests protect user-owned dynamic-tool disclosure state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";

type DynamicItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

test("a failed dynamic tool keeps its summary visible without opening its details", () => {
  const item: DynamicItem = {
    arguments: { retryCount: 3 },
    contentItems: [{ type: "inputText", text: "completed" }],
    durationMs: 9,
    id: "dynamic-one",
    namespace: "functions",
    status: "completed",
    success: false,
    tool: "custom_tool",
    type: "dynamicToolCall",
  };
  const html = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));

  assert.match(html, /custom_tool/u);
  assert.doesNotMatch(html, /<details[^>]*\bopen=/u);
});
