/*
 * Exports:
 * - No production exports; tests protect generic MCP routing plus wb MCP invocation and error details. Keywords: MCP, thread rendering, TypeScript, output.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadMcpToolCallItem from "./ThreadMcpToolCallItem";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function makeItem(overrides: Partial<McpItem> = {}): McpItem {
  return {
    appContext: null,
    arguments: { paths: [] },
    durationMs: 12,
    error: null,
    id: "mcp-one",
    pluginId: null,
    readOnlyHint: true,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Workbench arc comparison" }],
      structuredContent: null,
    },
    server: "wb",
    status: "completed",
    tool: "git_add",
    type: "mcpToolCall",
    ...overrides,
  };
}

test("unknown MCP calls keep the generic summary with the shared detail surface", () => {
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, {
    item: makeItem({
      error: { message: "Unknown tool failed." },
      result: null,
      server: "external",
      status: "failed",
      tool: "future_tool",
    }),
  }));

  assert.match(html, /external/u);
  assert.match(html, /future_tool/u);
  assert.match(html, /await tools\.mcp__external__future_tool\(/u);
});

test("failed simple wb MCP calls expose their invocation and error", () => {
  const html = renderToStaticMarkup(createElement(ThreadMcpToolCallItem, {
    item: makeItem({ error: { message: "File selection failed." }, result: null, status: "failed" }),
  }));

  assert.match(html, /await tools\.mcp__wb__git_add\(/u);
  assert.match(html, /File selection failed\./u);
});
