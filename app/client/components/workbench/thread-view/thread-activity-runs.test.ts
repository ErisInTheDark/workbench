/*
 * No production exports. Regression wards protect what joins an activity run, what breaks one, and how its steps group.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

import { buildActivityRuns } from "./thread-activity-runs";
import { buildRenderableBlocks, getRenderableBlockItems, type CommandItem, type ThreadRenderableBlock } from "./thread-render-blocks";

function command(id: string, text = "pwd"): CommandItem {
  return { id, type: "commandExecution", command: text, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}
function mcp(id: string, tool: string, args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"]): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
function reasoning(id: string): ThreadItem {
  return { type: "reasoning", id, summary: [id], content: [] };
}
function edit(id: string, path: string): ThreadItem {
  return { id, type: "dynamicToolCall", namespace: "claude", tool: "Edit", arguments: { file_path: path },
    status: "completed", success: true, contentItems: null, durationMs: 1 };
}

/** Runs as `run:[segment kinds and ids]`, other blocks as their kind and ids. */
function shape(items: ThreadItem[]) {
  return buildActivityRuns(buildRenderableBlocks(items)).map((block: ThreadRenderableBlock) => block.kind === "activityRun"
    ? ["run", block.segments.map(segment => [segment.kind, (segment.kind === "reasoning" ? [segment.item] : segment.items).map(item => item.id)])]
    : [block.kind, getRenderableBlockItems(block).map(item => item.id)]);
}

test("reasoning, plain commands, file edits and native reads share one run; adjacent commands share one group", () => {
  assert.deepEqual(shape([
    reasoning("think"), command("one"), command("two"), reasoning("again"),
    edit("edit-a", "a.ts"), edit("edit-b", "b.ts"), command("three"),
    { id: "native-read", type: "dynamicToolCall", namespace: "claude", tool: "Read", arguments: { file_path: "c.ts" },
      status: "completed", success: true, contentItems: null, durationMs: 1 },
  ]), [["run", [
    ["reasoning", ["think"]],
    ["commands", ["one", "two"]],
    ["reasoning", ["again"]],
    ["files", ["edit-a", "edit-b"]],
    ["commands", ["three", "native-read"]],
  ]]]);
});

test("conversation and lifecycle rows break runs and keep their own blocks", () => {
  const boundaries: Array<[ThreadItem, string]> = [
    [{ type: "agentMessage", id: "boundary", text: "reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null }, "agentCommentarySequence"],
    [command("boundary", 'wb git arc propose --title "Keep this visible"'), "commandSequence"],
    [command("boundary", "wb git arc scope"), "commandSequence"],
    [command("boundary", "wb git arc wait"), "commandSequence"],
    [command("boundary", 'wb task set --title "new title"'), "commandSequence"],
    [command("boundary", "wb task completed"), "commandSequence"],
    [command("boundary", "wb todo --required -- fix it"), "commandSequence"],
    [command("boundary", "wb vis start mockups/a.tsx"), "commandSequence"],
    [command("boundary", "wb subagent create --profile luna --name luna --title task --message hello"), "commandSequence"],
    [mcp("boundary", "task_set", { title: "new" }), "item"],
    [mcp("boundary", "git_arc_propose", { title: "Keep this visible" }), "item"],
  ];
  for (const [boundary, kind] of boundaries) {
    assert.deepEqual(shape([command("before"), boundary, command("after")]), [
      ["run", [["commands", ["before"]]]],
      [kind, ["boundary"]],
      ["run", [["commands", ["after"]]]],
    ], JSON.stringify(boundary));
  }
});

test("matcher-named vis checks group like other commands while unnamed dedicated rows stand alone", () => {
  assert.deepEqual(shape([command("before"), command("shot", "wb vis screenshot mockups/a.tsx"), command("after")]), [
    ["run", [["commands", ["before", "shot", "after"]]]],
  ]);
});

test("hidden calls leave no step and agent-only patch recovery context is never shown", () => {
  assert.deepEqual(shape([
    command("one"), mcp("hidden", "request_user_input", {}), command("two"),
    { id: "recovery", type: "functionCallOutput", namespace: "workbench", name: "patch_recovery", output: "context" },
  ]), [["run", [["commands", ["one", "two"]]]]]);
});
