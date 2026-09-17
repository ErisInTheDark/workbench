/*
 * No exports. Tests protect final row counting and conversation boundaries across CLI and MCP.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
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
function user(id: string): Extract<ThreadItem, { type: "userMessage" }> {
  return { clientId: null, content: [{ text: id, text_elements: [], type: "text" }], id, type: "userMessage" };
}
function steer(id: string, status: "pending" | "sent" | "failed" | "interrupted") {
  return withWorkbenchInputState(user(id), { kind: "steer", status });
}
const rows = (items: ThreadItem[]) => buildRenderableBlocks(items).flatMap(block => getWorkedBlockRows(block));

test("adjacent textual steers group only while their exact state matches", () => {
  const blocks = buildRenderableBlocks([
    steer("sent-a", "sent"),
    steer("sent-b", "sent"),
    steer("pending-a", "pending"),
    steer("pending-b", "pending"),
    steer("failed", "failed"),
    steer("interrupted", "interrupted"),
  ]);

  assert.deepEqual(blocks.map((block) => (
    block.kind === "userMessageSequence"
      ? { ids: block.items.map(({ id }) => id), kind: block.kind }
      : block.kind === "item"
        ? { id: block.item.id, kind: block.kind }
        : { ids: block.items.map(({ id }) => id), kind: block.kind }
  )), [
    { ids: ["sent-a", "sent-b"], kind: "userMessageSequence" },
    { ids: ["pending-a", "pending-b"], kind: "userMessageSequence" },
    { id: "failed", kind: "item" },
    { id: "interrupted", kind: "item" },
  ]);
});

test("ordinary messages and non-message items remain steer grouping boundaries", () => {
  const blocks = buildRenderableBlocks([
    steer("before", "sent"),
    user("initial"),
    steer("after-a", "sent"),
    command("boundary"),
    steer("after-b", "sent"),
  ]);

  assert.deepEqual(blocks.map((block) => (
    block.kind === "userMessageSequence"
      ? block.items.map(({ id }) => id)
      : block.kind === "item" ? block.item.id : block.items.map(({ id }) => id)
  )), ["before", "initial", "after-a", ["boundary"], "after-b"]);
});

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

test("proposal rows remain visible boundaries while other Git arc work stays collapsible", () => {
  assert.deepEqual(
    rows([command("proposal-cli", 'wb git arc propose --title "Keep this visible"')]).map(row => row.eligible),
    [false],
  );
  assert.deepEqual(
    rows([mcp("proposal-mcp", "git_arc_propose", { title: "Keep this visible" })]).map(row => row.eligible),
    [false],
  );
  assert.deepEqual(
    rows([
      command("scope-cli", "wb git arc scope"),
      mcp("status-mcp", "git_arc_status", {}),
    ]).map(row => row.eligible),
    [true, true],
  );
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
    { type: "dynamicToolCall", id: "question", namespace: null, tool: "request_user_input", arguments: {},
      contentItems: [], durationMs: null, status: "completed", success: true },
  ];
  for (const item of items) {
    assert.deepEqual(rows([command("before"), item, command("after")]).map(row => row.eligible), [true, false, true]);
  }
});

test("native plan items are excluded from render blocks", () => {
  const plan: ThreadItem = { type: "plan", id: "native-plan", text: "unsupported" };
  assert.deepEqual(buildRenderableBlocks([plan]), []);
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
