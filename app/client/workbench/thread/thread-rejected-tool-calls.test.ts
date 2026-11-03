/*
 * No production exports. Tests failed calls refused by a mode or naming an unknown tool are classified, across Workbench MCP and
 * native provider rows, while successful calls quoting the same text and ordinary failures are not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { describeModeToolDenial } from "workbench-shared/workbench/thread/workflow-denials";
import { getRejectedToolCallKind } from "./thread-rejected-tool-calls";

function mcp(text: string, status: "completed" | "failed" = "failed"): ThreadItem {
  return {
    type: "mcpToolCall", id: "call", server: "wb", tool: "shell", arguments: {}, status, error: null, durationMs: 1,
    result: { content: [{ type: "text", text }], structuredContent: null, _meta: null }, appContext: null, pluginId: null, readOnlyHint: null,
  };
}

function native(text: string): ThreadItem {
  return {
    type: "dynamicToolCall", id: "native", namespace: "claude", tool: "Read", arguments: {}, status: "failed",
    contentItems: [{ type: "inputText", text }], success: false, durationMs: null,
  };
}

test("mode and lock refusals are mode denials, wrapped or native", () => {
  assert.equal(getRejectedToolCallKind(mcp(`Workbench shell failed: ${describeModeToolDenial("Review", "shell")}`)), "modeDenial");
  assert.equal(getRejectedToolCallKind(native(`PreToolUse:Read hook error: ${describeModeToolDenial("Review", "read")}`)), "modeDenial");
});

test("calls to tools the provider does not have are unknown tools", () => {
  assert.equal(getRejectedToolCallKind(native("<tool_use_error>Error: No such tool available: shell</tool_use_error>")), "unknownTool");
  assert.equal(getRejectedToolCallKind(mcp("<tool_use_error>Error: No such tool available: mcp__wb__Read</tool_use_error>")), "unknownTool");
  assert.equal(getRejectedToolCallKind(native("Native OpenCode tool glob is unavailable in a managed Workbench session.")), "unknownTool");
});

test("successful calls quoting refusals and ordinary failures stay visible", () => {
  assert.equal(getRejectedToolCallKind(mcp(describeModeToolDenial("Review", "rg"), "completed")), null);
  assert.equal(getRejectedToolCallKind(mcp("Command failed with exit code 1.")), null);
});
