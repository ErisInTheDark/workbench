/*
 * No exports. Tests protect final row counting and conversation boundaries across CLI and MCP.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { buildRenderableBlocks, getWorkedBlockRows, type CommandItem } from "./thread-render-blocks";
import { partitionWorkedRows } from "./thread-worked-run";

function command(id: string, text = "pwd"): CommandItem {
  return { id, type: "commandExecution", command: text, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}
function mcp(id: string, tool: string, args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"]): ThreadItem {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
const rows = (items: ThreadItem[]) => buildRenderableBlocks(items).flatMap(block => getWorkedBlockRows(block));

test("merged commands and reasoning count once each and hidden calls count zero", () => {
  const items: ThreadItem[] = [
    command("one"), command("two"),
    { type: "reasoning", id: "reason-a", summary: ["one"], content: [] },
    { type: "reasoning", id: "reason-b", summary: ["two"], content: [] },
    mcp("hidden", "request_user_input", {}),
    command("three"), command("four"),
  ];
  assert.equal(rows(items).length, 3);
  assert.deepEqual(partitionWorkedRows(rows(items)).map(group => group.length), [3]);
});

test("standalone Git rows count separately while CLI task actions split runs", () => {
  const result = rows([
    command("one"), command("two"),
    command("git", "wb git arc scope"),
    command("title", 'wb task set --title "new title"'),
    command("status", "wb task completed"),
    command("three"),
  ]);
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(row => row.eligible), [true, true, false, false, true]);
  assert.deepEqual(partitionWorkedRows(result).map(group => group.length), [2, 1, 1, 1]);
});

test("MCP task actions and outgoing subagent messages remain boundaries", () => {
  const result = rows([
    command("before"),
    mcp("title", "task_set", { title: "new" }),
    mcp("status", "task_completed", {}),
    mcp("message", "subagent_message", { name: "luna", message: "hello" }),
    command("after"),
  ]);
  assert.deepEqual(result.map(row => row.eligible), [true, false, false, false, true]);
});

test("conversation and unclassified interaction rows break work runs", () => {
  const items: ThreadItem[] = [
    { type: "userMessage", id: "user", clientId: null, content: [{ type: "text", text: "hello", text_elements: [] }] },
    { type: "agentMessage", id: "assistant", text: "reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
    { type: "plan", id: "plan", text: "a plan" },
    { type: "dynamicToolCall", id: "question", namespace: null, tool: "request_user_input", arguments: {},
      contentItems: [], durationMs: null, status: "completed", success: true },
  ];
  for (const item of items) {
    assert.deepEqual(rows([command("before"), item, command("after")]).map(row => row.eligible), [true, false, true]);
  }
});

test("subagent creation and incoming native messages cannot enter worked groups", () => {
  const items: ThreadItem[] = [
    command("create-cli", 'wb subagent create --profile luna --name luna --title task --message hello'),
    command("message-cli", 'wb subagent message --name luna --message hello'),
    mcp("create-mcp", "subagent_create", { profileId: "luna", name: "luna", title: "task", message: "hello" }),
    { id: "incoming", type: "functionCallOutput", namespace: "workbench", name: "agent_message", output: "incomplete message envelope" },
  ];
  for (const item of items) {
    assert.deepEqual(rows([command("before"), item, command("after")]).map(row => row.eligible), [true, false, true]);
  }
});
