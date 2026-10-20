/*
 * No production exports. Tests protect when failed Git arc starts fold into their successful retry: only a completed
 * retry folds, only work and arc reads fold between, and MCP and CLI starts fold alike.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { buildActivityRuns } from "./thread-activity-runs";
import { foldGitArcRetries } from "./thread-git-arc-retries";
import { buildRenderableBlocks, type CommandItem } from "./thread-render-blocks";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function mcp(id: string, tool: string, status: McpItem["status"] = "completed"): McpItem {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: {}, status, result: null,
    error: status === "failed" ? { message: "The plan baseline changed." } : null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
function cli(id: string, command: string, exitCode: number | null = 0): CommandItem {
  return { id, type: "commandExecution", command, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: exitCode === null ? "inProgress" : "completed" };
}
function thought(id: string): ThreadItem {
  return { type: "reasoning", id, summary: [id], content: [] };
}
function commentary(id: string): ThreadItem {
  return { type: "agentMessage", id, text: id, phase: "commentary", memoryCitation: null, delivery: null, questions: null };
}

function fold(items: ThreadItem[]) {
  return foldGitArcRetries(buildActivityRuns(buildRenderableBlocks(items)));
}

test("a failed start, the work after it and the start that succeeded become one retry", () => {
  const blocks = fold([
    mcp("failed", "git_arc_start", "failed"), thought("why"), mcp("diffed", "git_arc_diff"), mcp("status", "git_arc_status"),
    mcp("started", "git_plan_start"),
  ]);
  assert.equal(blocks.length, 1);
  const [retry] = blocks;
  assert.equal(retry?.kind, "gitArcRetry");
  if (retry?.kind !== "gitArcRetry") return;
  assert.equal(retry.failedAttempts, 1);
  assert.deepEqual(retry.items.map(item => item.id), ["failed", "why", "diffed", "status", "started"]);
  assert.deepEqual(retry.success.kind === "item" ? retry.success.item.id : null, "started");
  // The steps keep their order, so the card tells what happened before the start worked.
  assert.deepEqual(retry.history.flatMap(segment => "items" in segment ? segment.items.map(item => item.id) : [segment.item.id]),
    ["failed", "why", "diffed", "status"]);
});

test("nothing folds until a retry completes", () => {
  const failedThenWork = [mcp("failed", "git_arc_start", "failed"), thought("why")];
  assert.deepEqual(fold(failedThenWork).map(block => block.kind), ["item", "activityRun"]);
  assert.deepEqual(fold([...failedThenWork, mcp("running", "git_arc_start", "inProgress")]).map(block => block.kind), ["item", "activityRun", "item"]);
  assert.deepEqual(fold([...failedThenWork, mcp("again", "git_arc_start", "failed")]).map(block => block.kind), ["item", "activityRun", "item"]);
});

test("words to the user and other cards keep the failure and the retry apart", () => {
  assert.deepEqual(fold([mcp("failed", "git_arc_start", "failed"), commentary("drifted, checking"), mcp("started", "git_arc_start")])
    .map(block => block.kind), ["item", "agentCommentarySequence", "item"]);
  assert.deepEqual(fold([mcp("failed", "git_arc_start", "failed"), mcp("proposed", "git_arc_propose"), mcp("started", "git_arc_start")])
    .map(block => block.kind), ["item", "item", "item"]);
});

test("every failed attempt before the success folds and counts", () => {
  const [retry] = fold([
    mcp("one", "git_arc_start", "failed"), thought("hm"), mcp("two", "git_arc_start", "failed"), mcp("started", "git_arc_start"),
  ]);
  assert.equal(retry?.kind === "gitArcRetry" ? retry.failedAttempts : null, 2);
});

test("CLI starts fold like MCP starts", () => {
  const blocks = fold([cli("failed", "wb git arc start", 1), thought("why"), cli("started", "wb git plan start --inherit")]);
  assert.deepEqual(blocks.map(block => block.kind), ["gitArcRetry"]);
  assert.deepEqual(fold([cli("failed", "wb git arc start", 1), cli("running", "wb git arc start", null)]).map(block => block.kind),
    ["commandSequence", "commandSequence"]);
});
