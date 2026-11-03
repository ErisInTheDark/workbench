/* No exports. Protect the live status verb: reasoning first, then the newest running call's simplest action, and which waits block on the user. */
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { getLiveThreadVerb, isLiveThreadWaitingForProposalAcceptance } from "./thread-live-activity";

const context = { cwd: "/project", projectRootPath: "/project" };

function command(id: string, text: string, status: "inProgress" | "completed" = "inProgress", cwd = "/project"): ThreadItem {
  return {
    id, type: "commandExecution", command: text, cwd,
    commandActions: text.startsWith("cat ") ? [{ type: "read", command: text, name: text.slice(4), path: text.slice(4) }] : [],
    status, aggregatedOutput: null, durationMs: null, exitCode: null, processId: null,
    pluginId: null, scriptPath: null, source: "agent",
  };
}
function mcp(id: string, server: string, tool: string, args: JsonValue = {}, extra: Partial<Extract<ThreadItem, { type: "mcpToolCall" }>> = {}): ThreadItem {
  return {
    id, type: "mcpToolCall", server, tool, arguments: args, status: "inProgress", durationMs: null, result: null, error: null,
    appContext: null, pluginId: null, readOnlyHint: null, ...extra,
  };
}
function fileChange(...kinds: Array<"add" | "delete" | "update">): ThreadItem {
  return {
    id: "patch", type: "fileChange", status: "inProgress",
    changes: kinds.map((kind, index) => ({ path: `f${index}.ts`, diff: "", kind: kind === "update" ? { type: kind, move_path: null } : { type: kind } })),
  };
}
const reasoning: ThreadItem = { id: "reasoning", type: "reasoning", summary: ["**Considering**\nMore."], content: [] };
function liveTurn(items: ThreadItem[]): Turn {
  return { id: "turn", status: "inProgress", items, itemsView: "full", error: null, startedAt: 0, completedAt: null, durationMs: null };
}
function verb(items: ThreadItem[]) {
  return getLiveThreadVerb({ context, pendingUserInputRequest: null, turn: liveTurn(items) });
}
function waitingForProposal(items: ThreadItem[]) {
  return isLiveThreadWaitingForProposalAcceptance({ context, turn: liveTurn(items) });
}

test("running calls read as their simplest action, newest first", () => {
  assert.equal(verb([command("a", "cat a.txt")]), "Reading");
  assert.equal(verb([command("a", "cat a.txt"), command("b", "frobnicate --hard")]), "Executing");
  assert.equal(verb([command("b", "frobnicate --hard"), command("a", "cat a.txt", "completed")]), "Executing");
  assert.equal(verb([command("a", "wb git arc propose --title fix")]), "Proposing");
  assert.equal(verb([mcp("a", "wb", "git_plan_claims", { intentName: "x", addPaths: ["a.ts"] })]), "Planning");
  assert.equal(verb([mcp("a", "wb", "thread_recall")]), "Recalling");
  assert.equal(verb([mcp("a", "wb", "browse_run", { commands: ["open https://example.com"] })]), "Browsing");
  assert.equal(verb([mcp("a", "custom", "frobnicate")]), "Executing");
  assert.equal(verb([command("a", "wb thread recall", "inProgress", "/elsewhere")]), "Recalling");
});

test("only a live proposal acceptance wait blocks on the user", () => {
  assert.equal(waitingForProposal([mcp("wait", "wb", "git_arc_wait", { proposalId: "p" })]), true);
  assert.equal(waitingForProposal([mcp("wait", "wb", "git_arc_wait", { proposalId: "*" })]), true);
  assert.equal(waitingForProposal([mcp("wait", "wbex", "git_arc_wait", { proposalId: "p" })]), true);
  assert.equal(waitingForProposal([mcp("call", "wb", "mcp_call", { server: "wb", tool: "git_arc_wait", arguments: { proposalId: "p" } })]), true);
  assert.equal(waitingForProposal([command("wait", "wb git arc wait --proposal p")]), true);
  // Claims waits, settled waits and ordinary work are not the user's decision to make.
  assert.equal(waitingForProposal([mcp("wait", "wb", "git_arc_wait", { ref: "a".repeat(40) })]), false);
  assert.equal(waitingForProposal([command("wait", "wb git arc wait")]), false);
  assert.equal(waitingForProposal([mcp("wait", "wb", "git_arc_wait", { proposalId: "p" }, { status: "completed" })]), false);
  assert.equal(waitingForProposal([mcp("wait", "wb", "git_arc_wait", { proposalId: "p" }, { error: { message: "stopped" } })]), false);
  assert.equal(waitingForProposal([command("wait", "wb git arc wait --proposal p", "completed")]), false);
  assert.equal(waitingForProposal([]), false);
  assert.equal(isLiveThreadWaitingForProposalAcceptance({ context, turn: null }), false);
});

test("file patches name what they do to the files", () => {
  assert.equal(verb([fileChange("add", "add")]), "Creating");
  assert.equal(verb([fileChange("delete")]), "Deleting");
  assert.equal(verb([fileChange("add", "update")]), "Editing");
});

test("reasoning outranks running calls, even behind a pending steer", () => {
  const steer = withWorkbenchInputState({
    clientId: null, content: [{ text: "queued", text_elements: [], type: "text" as const }],
    id: "steer", type: "userMessage" as const,
  }, { kind: "optimistic", placement: "steer", status: "pending" });
  assert.equal(verb([command("a", "cat a.txt"), reasoning, steer]), "Thinking");
  assert.equal(verb([reasoning, command("a", "cat a.txt")]), "Reading");
});

test("an execute wrapper never speaks over its running wb child or a retired rollover", () => {
  const wrapper: ThreadItem = {
    id: "wrapper", type: "dynamicToolCall", namespace: "opencode", tool: "execute", toolCallGroupId: "group",
    arguments: { code: "opaque" }, status: "inProgress", contentItems: null, durationMs: null, success: null,
  };
  assert.equal(verb([mcp("child", "wb", "thread_recall", {}, { toolCallGroupId: "group" }), wrapper]), "Recalling");
  const rollover = mcp("child", "wb", "thread_compact", {}, { toolCallGroupId: "group", status: "completed" });
  assert.equal(verb([rollover, wrapper]), "Thinking");
});

test("connecting and compaction keep their own status", () => {
  const compaction = { id: "compaction", type: "contextCompaction", status: "inProgress" } as const satisfies ThreadItem;
  const pending = withWorkbenchInputState({
    clientId: "client", content: [{ type: "text", text: "next", text_elements: [] }],
    id: "pending", type: "userMessage",
  } as const satisfies Extract<ThreadItem, { type: "userMessage" }>, { kind: "optimistic", placement: "initial", status: "pending" });
  assert.equal(verb([compaction, pending]), null);
  assert.equal(verb([pending]), "Connecting");
  assert.equal(getLiveThreadVerb({ context, pendingUserInputRequest: null, turn: null }), null);
});
