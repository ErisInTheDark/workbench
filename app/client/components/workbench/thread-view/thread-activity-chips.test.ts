/*
 * No production exports. Regression wards protect activity summary chip counting and order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatGitArcEditText } from "workbench-shared/workbench/git/git-arc-edit-contracts";
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

type EditPhase = "applied" | "ended" | "preview" | "reverted";

function editResult(phase: EditPhase, session: string, files: Array<[string, number, number]>, fileCount = files.length) {
  return {
    additions: files.reduce((total, [, additions]) => total + additions, 0), blockedDirtyPaths: [], blockedPendingPaths: [], claimedCount: 0,
    collisions: [], conflictedPaths: [], deletions: files.reduce((total, [, , deletions]) => total + deletions, 0), diffs: [], fileCount,
    files: files.map(([path, additions, deletions]) => ({ additions, binary: false, deletions, ignored: false, lines: [], path })),
    ignoredFileCount: 0, page: 1, pageCount: 1, phase, releasedCount: 0, session, skippedFileCount: 0, warnings: [],
  };
}

const EDIT_TOOLS: Record<EditPhase, string> = { applied: "git_arc_edit_apply", ended: "git_arc_edit_end", preview: "git_arc_edit_start", reverted: "git_arc_edit_revert" };

/** An edit session call through deferred `mcp_call`, its result in structured content. */
function arcEdit(id: string, phase: EditPhase, session: string, files: Array<[string, number, number]>, fileCount?: number) {
  const edit = editResult(phase, session, files, fileCount);
  return { ...wb(id, "mcp_call", { server: "wb", tool: EDIT_TOOLS[phase], arguments: {} }),
    result: { _meta: null, content: [], structuredContent: { kind: "success", version: 1, edit } } };
}

test("an applied arc edit adds its files and totals to the edited chip, once per session, merged with ordinary edits", () => {
  const files: Array<[string, number, number]> = [["a.ts", 1, 1], ["moved.ts", 2, 2]];
  assert.deepEqual(chips([
    { items: [arcEdit("preview", "preview", "s1", files), arcEdit("apply", "applied", "s1", files), arcEdit("end", "ended", "s1", files)], kind: "commands" },
    { items: [patch("patch", [["a.ts", "update", "@@ -1 +1 @@\n-a\n+b"]])], kind: "files" },
  ]), [["update", 2, 4, 4], ["arc", 3, null, null]]);
});

test("an edit session the run reverts adds nothing, and files past the first page still count", () => {
  assert.deepEqual(chips([{ items: [
    arcEdit("apply", "applied", "s1", [["a.ts", 1, 1]]), arcEdit("revert", "reverted", "s1", [["a.ts", 1, 1]]),
  ], kind: "commands" }]), [["arc", 2, null, null]]);
  assert.deepEqual(chips([{ items: [arcEdit("apply", "applied", "s2", [["a.ts", 1, 1]], 150)], kind: "commands" }]),
    [["update", 150, 1, 1], ["arc", 1, null, null]]);
});

test("a CLI edit apply counts from its printed result like an MCP one", () => {
  const applied = { ...command("cli", "wb git arc edit apply"), aggregatedOutput: formatGitArcEditText(editResult("applied", "s3", [["b.ts", 3, 0]])) };
  assert.deepEqual(chips([{ items: [applied], kind: "commands" }]), [["update", 1, 3, 0], ["arc", 1, null, null]]);
});

test("web searches count with matched web requests and a reasoning-only run has no chips", () => {
  assert.deepEqual(chips([{ items: [
    { action: null, id: "web", query: "workbench", type: "webSearch" } as Extract<ThreadItem, { type: "webSearch" }>,
  ], kind: "webSearch" }]), [["web", 1, null, null]]);
  assert.deepEqual(chips([{ item: { content: [], id: "r", summary: ["x"], type: "reasoning" }, kind: "reasoning" }]), []);
});
