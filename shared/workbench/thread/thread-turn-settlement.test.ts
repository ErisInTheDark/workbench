/*
 * No production exports. Tests protect what an ended turn means for its items: running tool calls are over, and
 * nothing else changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "./workbench-thread-items.ts";
import { endTurnItem } from "./thread-turn-settlement.ts";

const command = (status: "inProgress" | "failed"): ThreadItem => ({
  id: "cmd", type: "commandExecution", command: "cargo build", commandActions: [], cwd: "C:/repo", durationMs: null,
  exitCode: null, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status,
});
const wbCall: ThreadItem = {
  id: "wb", type: "mcpToolCall", server: "wb", tool: "shell", arguments: { command: "wb test" }, status: "inProgress",
  result: null, error: null, durationMs: null, appContext: null, pluginId: null, readOnlyHint: null,
};

test("a running tool call in an ended turn is over", () => {
  const status = (item: ThreadItem) => "status" in item ? item.status : null;
  assert.deepEqual([status(endTurnItem(command("inProgress"))), status(endTurnItem(wbCall))], ["completed", "completed"]);
});

test("settled calls and items without a lifecycle stay exactly as they are", () => {
  const failed = command("failed");
  assert.equal(endTurnItem(failed), failed);
  const reasoning: ThreadItem = { id: "r", type: "reasoning", summary: ["hm"], content: [] };
  assert.equal(endTurnItem(reasoning), reasoning);
});
