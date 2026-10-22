/*
 * No production exports. Regression wards protect activity summary chip counting and order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

import { getActivityChips } from "./thread-activity-chips";
import type { ActivitySegment, CommandItem } from "./thread-render-blocks";

function command(id: string, text: string): CommandItem {
  return { id, type: "commandExecution", command: text, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}

function patch(id: string, changes: Array<[string, "add" | "update" | "delete", string]>, status: "completed" | "failed" = "completed") {
  return {
    id, type: "fileChange", status,
    changes: changes.map(([path, kind, diff]) => ({ diff, kind: kind === "update" ? { move_path: null, type: kind } : { type: kind }, path })),
  } as Extract<ThreadItem, { type: "fileChange" }>;
}

function wb(id: string, tool: string, args: Extract<ThreadItem, { type: "mcpToolCall" }>["arguments"]): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}

const chips = (segments: ActivitySegment[]) => getActivityChips(segments, {}).map(chip => [chip.key, chip.count, chip.additions ?? null, chip.deletions ?? null]);

test("file chips lead in created, edited, deleted order, counting each file once with summed totals", () => {
  assert.deepEqual(chips([
    { items: [
      { id: "read", type: "dynamicToolCall", namespace: "claude", tool: "Read", arguments: { file_path: "a.ts" },
        status: "completed", success: true, contentItems: null, durationMs: 1 },
      command("run", "node build.js"),
    ], kind: "commands" },
    { items: [
      patch("one", [["a.ts", "update", "@@ -1 +1,2 @@\n-a\n+b\n+c"], ["gone.ts", "delete", "@@ -1,2 +0,0 @@\n-x\n-y"]]),
      patch("two", [["a.ts", "update", "@@ -1 +1 @@\n-b\n+d"], ["new.ts", "add", "@@ -0,0 +1 @@\n+n"]]),
      patch("failed", [["other.ts", "update", "@@ -1 +1 @@\n-a\n+b"]], "failed"),
    ], kind: "files" },
  ]), [
    ["add", 1, 1, null],
    ["update", 1, 3, 2],
    ["delete", 1, null, 2],
    ["read", 1, null, null],
    ["exec", 1, null, null],
  ]);
});

test("Browse calls count their steps, then the screenshots the agent explicitly took", () => {
  const run = command("browse", 'wb browse run --command "open http://localhost:3002" --command screenshot --command "click text=Save"');
  const entry = (actionIndex: number, action: string, assetUrl: string) => ({ action, actionIndex, assetUrl, commandItemId: "browse",
    durationMs: 5, entryKey: action, recordedAt: actionIndex, session: null, state: "completed" as const, threadId: "thread", turnId: "turn" });
  const entries = [entry(0, "open", "/asset/auto.png"), entry(1, "screenshot", "/asset/shot.png")];
  assert.deepEqual(getActivityChips([{ items: [run], kind: "commands" }], { browseResultEntries: entries }).map(chip => [chip.key, chip.count]), [
    ["browse", 3],
    ["screenshots", 1],
  ]);
});

test("thread recalls count as recalled, whether called through MCP or the CLI", () => {
  assert.deepEqual(chips([{ items: [
    { id: "read", type: "dynamicToolCall", namespace: "claude", tool: "Read", arguments: { file_path: "a.ts" },
      status: "completed", success: true, contentItems: null, durationMs: 1 },
    wb("recall", "thread_recall", {}),
    wb("search", "thread_recall_search", { query: "cache" }),
    command("cli", "wb thread recall"),
  ], kind: "commands" }]), [["read", 1, null, null], ["recalled", 3, null, null]]);
});

test("a step with its own renderer and no stat still counts as exec, so no step goes uncounted", () => {
  assert.deepEqual(chips([{ items: [
    wb("vis", "vis_start", { path: "mock.tsx" }),
    command("run", "node build.js"),
  ], kind: "commands" }]), [["exec", 2, null, null]]);
});

test("arc reads merged into a command group count as arc steps beside the commands", () => {
  assert.deepEqual(chips([{ items: [
    command("one", "node build.js"),
    wb("compare", "git_arc_compare", {}),
    wb("claims", "git_arc_claims", { inherit: true, addPaths: ["src/a.ts"] }),
    command("two", "node test.js"),
  ], kind: "commands" }]), [["arc", 2, null, null], ["exec", 2, null, null]]);
});

test("web searches count with matched web requests and a reasoning-only run has no chips", () => {
  assert.deepEqual(chips([{ items: [
    { action: null, id: "web", query: "workbench", type: "webSearch" } as Extract<ThreadItem, { type: "webSearch" }>,
  ], kind: "webSearch" }]), [["web", 1, null, null]]);
  assert.deepEqual(chips([{ item: { content: [], id: "r", summary: ["x"], type: "reasoning" }, kind: "reasoning" }]), []);
});
