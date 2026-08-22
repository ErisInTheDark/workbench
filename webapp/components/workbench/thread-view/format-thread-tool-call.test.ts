/*
 * Exports:
 * - No production exports; tests protect TypeScript-shaped MCP/dynamic invocations and text-first output formatting. Keywords: tool call, TypeScript, output, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatDynamicToolInvocation,
  formatMcpToolInvocation,
  formatToolCallOutput,
} from "./format-thread-tool-call.ts";

test("MCP calls render as the TypeScript tool invocation shape", () => {
  assert.equal(formatMcpToolInvocation({
    argumentsValue: {
      paths: [],
      "plan-ref": "abc",
      nested: [{ active: true }, null],
    },
    server: "wb",
    tool: "git_arc_compare",
  }), [
    "await tools.mcp__wb__git_arc_compare({",
    "  paths: [],",
    '  "plan-ref": "abc",',
    "  nested: [",
    "    {",
    "      active: true,",
    "    },",
    "    null,",
    "  ],",
    "})",
  ].join("\n"));
});

test("dynamic calls preserve qualified and unsafe callable names", () => {
  assert.equal(
    formatDynamicToolInvocation({ argumentsValue: {}, namespace: "functions", tool: "request_user_input" }),
    "await functions.request_user_input({})",
  );
  assert.equal(
    formatDynamicToolInvocation({ argumentsValue: null, namespace: "odd-namespace", tool: "tool-name" }),
    'await tools["odd-namespace"]["tool-name"](null)',
  );
});

test("tool output prefers text and preserves structured fallbacks", () => {
  assert.equal(formatToolCallOutput({
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  }), "first\n\nsecond");
  assert.equal(formatToolCallOutput({ fallback: { ok: true } }), '{\n  "ok": true\n}');
});
