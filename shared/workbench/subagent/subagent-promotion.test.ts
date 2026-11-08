/*
 * Exports: none. Tests protect which promote items prove a take back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "../thread/workbench-thread-items";
import { findPromotedChild, formatPromotedSubagent, formatUnpromotedSubagent } from "./subagent-promotion";

const output = [formatPromotedSubagent("Mira", "child-1"), formatUnpromotedSubagent("Basil", "only an unsettled subagent can be promoted.")].join("\n");
const call = (overrides: Record<string, unknown>) => ({
  type: "mcpToolCall", id: "item", server: "wb", tool: "subagent_promote", status: "completed", arguments: { names: ["Mira", "Basil"] },
  result: { content: [{ type: "text", text: output }], structuredContent: null }, error: null, durationMs: 1, ...overrides,
}) as unknown as ThreadItem;

test("only a completed promote call naming the promoted thread proves a take back", () => {
  assert.deepEqual(findPromotedChild(call({}), "child-1"), { name: "Mira", threadId: "child-1", failure: null });
  assert.equal(findPromotedChild(call({ tool: "mcp_call", arguments: { server: "wb", tool: "subagent_promote" } }), "child-1")?.name, "Mira");
  assert.equal(findPromotedChild(call({}), "someone-else"), null);
  assert.equal(findPromotedChild(call({ status: "inProgress" }), "child-1"), null);
  assert.equal(findPromotedChild(call({ tool: "subagent_settle" }), "child-1"), null);
  assert.equal(findPromotedChild(call({ tool: "mcp_call", arguments: { tool: "subagent_settle" } }), "child-1"), null);
  assert.equal(findPromotedChild(undefined, "child-1"), null);
});
