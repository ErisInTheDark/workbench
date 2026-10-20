/* No production exports. Tests protect which native and canonical file pieces grow one row and which stay standalone. */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import type { NativeFileOperationItem } from "../../../workbench/thread/thread-command-matchers";
import { getStitchedRowSpan, stitchFileOperationRows } from "./thread-file-change-stitching";

type Status = "completed" | "failed" | "inProgress";

function edit(id: string, path: string, status: Status = "completed", { tool = "Edit", unclaimed = false } = {}): NativeFileOperationItem {
  return {
    id, type: "dynamicToolCall", namespace: "claude", tool,
    arguments: { file_path: path }, status, success: status === "failed" ? false : status === "completed" ? true : null,
    contentItems: null, durationMs: null,
    metadata: { fileChange: { kind: "update", diff: "@@ -1,1 +1,1 @@\n-a\n+b" }, ...(unclaimed ? { workbenchFailureKind: "unclaimed" } : {}) },
  };
}

const unclaimed = (id: string, status: Status = "failed") => edit(id, "a.ts", status, { unclaimed: true });

function rows(items: Parameters<typeof stitchFileOperationRows>[0]) {
  return stitchFileOperationRows(items).map(group => group.kind === "fileChange" && !group.rows.length
    ? [group.item.id]
    : group.rows.map(row => row.pieces.map(piece => piece.item.id).join("+")));
}

function codexEdit(id: string, path: string, kind: "add" | "update" = "update", status: WorkbenchFileChangeItem["status"] = "completed"): WorkbenchFileChangeItem {
  return {
    id, type: "fileChange", status,
    changes: [{ path, diff: "@@ -1,1 +1,1 @@\n-a\n+b", kind: kind === "add" ? { type: "add" } : { type: "update", move_path: null } }],
  };
}

test("back-to-back canonical changes of one kind on one file grow one row", () => {
  assert.deepEqual(rows([codexEdit("1", "a.ts"), codexEdit("2", "a.ts"), codexEdit("3", "a.ts")]), [["1+2+3"]]);
  assert.deepEqual(rows([codexEdit("1", "a.ts", "add"), codexEdit("2", "a.ts")]), [["1"], ["2"]]);
  assert.deepEqual(rows([codexEdit("1", "a.ts"), codexEdit("2", "b.ts"), codexEdit("3", "a.ts")]), [["1"], ["2"], ["3"]]);
  assert.deepEqual(rows([codexEdit("1", "a.ts"), codexEdit("2", "a.ts", "update", "failed")]), [["1"], ["2"]]);
});

test("back-to-back edits of one file grow one row anchored at the first, including a streaming edit", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "a.ts"), edit("3", "a.ts", "inProgress")]), [["1+2+3"]]);
});

test("any different row between edits breaks the run", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "b.ts"), edit("3", "a.ts")]), [["1"], ["2"], ["3"]]);
  const codex: WorkbenchFileChangeItem = { id: "codex", type: "fileChange", status: "completed", changes: [] };
  assert.deepEqual(rows([edit("1", "a.ts"), codex, edit("2", "a.ts")]), [["1"], ["codex"], ["2"]]);
});

test("failed edits never absorb or join an applied run", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "a.ts", "failed"), edit("3", "a.ts")]), [["1"], ["2"], ["3"]]);
});

test("back-to-back identical failures on one file merge into one row", () => {
  assert.deepEqual(rows([unclaimed("1"), unclaimed("2"), unclaimed("3")]), [["1+2+3"]]);
});

test("different failures, targets, or operations keep separate rows", () => {
  assert.deepEqual(rows([unclaimed("1"), edit("2", "a.ts", "failed")]), [["1"], ["2"]]);
  assert.deepEqual(rows([unclaimed("1"), edit("2", "b.ts", "failed", { unclaimed: true })]), [["1"], ["2"]]);
  assert.deepEqual(rows([unclaimed("1"), edit("2", "a.ts", "failed", { tool: "Write", unclaimed: true })]), [["1"], ["2"]]);
});

test("a live retry joins the failure run, and stays only if it fails the same way", () => {
  assert.deepEqual(rows([unclaimed("1"), unclaimed("2"), unclaimed("3", "inProgress")]), [["1+2+3"]]);
  assert.deepEqual(rows([unclaimed("1"), unclaimed("2"), edit("3", "a.ts")]), [["1+2"], ["3"]]);
});

test("a stitched row spans from its first piece starting to its last piece finishing", () => {
  const timing = (itemId: string, startedAt: number | null, completedAt: number | null, firstSeenAt: number | null = null) => (
    { itemId, startedAt, completedAt, firstSeenAt, lastSeenAt: null });
  const items = [edit("1", "a.ts"), edit("2", "a.ts"), edit("3", "a.ts")];
  assert.deepEqual(getStitchedRowSpan(items, [timing("1", 1_000, 1_200), timing("2", 4_000, 4_300), timing("3", 9_000, 9_500)]),
    { startedAtMs: 1_000, durationMs: 8_500 });
  // A piece the timeline only saw arrive still marks the start; a row with no timing has no span.
  assert.deepEqual(getStitchedRowSpan(items, [timing("1", null, null, 2_000), timing("3", 9_000, 9_500)]), { startedAtMs: 2_000, durationMs: 7_500 });
  assert.equal(getStitchedRowSpan(items, []), null);
  // Still running: the span has begun but has no end yet.
  assert.deepEqual(getStitchedRowSpan(items, [timing("1", 1_000, 1_200), timing("3", 9_000, null)]), { startedAtMs: 1_000, durationMs: null });
});

test("deletes and moves stay standalone", () => {
  const removal: NativeFileOperationItem = {
    id: "rm", type: "mcpToolCall", server: "wb", tool: "rm", arguments: { paths: ["a.ts"] }, status: "completed",
    result: null, error: null, durationMs: null, appContext: null, pluginId: null, readOnlyHint: null,
  };
  const move: NativeFileOperationItem = {
    id: "move", type: "dynamicToolCall", namespace: "opencode", tool: "patch",
    arguments: { patchText: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: c.ts\n*** End Patch" },
    status: "completed", success: true, contentItems: null, durationMs: null,
  };
  assert.deepEqual(rows([edit("1", "a.ts"), move, edit("2", "a.ts")]), [["1"], ["move"], ["2"]]);
  assert.deepEqual(rows([edit("1", "a.ts"), removal, edit("2", "a.ts")]), [["1"], ["rm"], ["2"]]);
});
