/*
 * Exports:
 * - No production exports; tests protect shell-style generic dynamic-tool details without changing special tool ownership. Keywords: dynamic tool, TypeScript, output, rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";

type DynamicItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

test("generic dynamic tools render TypeScript-shaped input and ordinary output", () => {
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

  assert.match(html, /await functions\.custom_tool\(/u);
  assert.match(html, /retryCount: 3/u);
  assert.match(html, /completed/u);
  assert.doesNotMatch(html, />Arguments<|>Content items<|>Success:</u);
});
