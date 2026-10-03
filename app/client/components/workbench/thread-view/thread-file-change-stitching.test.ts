/* No production exports. Tests protect which native file pieces grow one row and which stay standalone. */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import type { NativeFileOperationItem } from "../../../workbench/thread/thread-command-matchers";
import { stitchFileOperationRows } from "./thread-file-change-stitching";

type Status = "completed" | "failed" | "inProgress";

function edit(id: string, path: string, status: Status = "completed"): NativeFileOperationItem {
  return {
    id, type: "dynamicToolCall", namespace: "claude", tool: "Edit",
    arguments: { file_path: path }, status, success: status === "failed" ? false : status === "completed" ? true : null,
    contentItems: null, durationMs: null,
    metadata: { fileChange: { kind: "update", diff: "@@ -1,1 +1,1 @@\n-a\n+b" } },
  };
}

function rows(items: Parameters<typeof stitchFileOperationRows>[0]) {
  return stitchFileOperationRows(items).map(group => group.kind === "native"
    ? group.rows.map(row => row.pieces.map(piece => piece.item.id).join("+"))
    : [group.item.id]);
}

test("back-to-back edits of one file grow one row anchored at the first, including a streaming edit", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "a.ts"), edit("3", "a.ts", "inProgress")]), [["1+2+3"]]);
});

test("any different row between edits breaks the run", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "b.ts"), edit("3", "a.ts")]), [["1"], ["2"], ["3"]]);
  const codex: WorkbenchFileChangeItem = { id: "codex", type: "fileChange", status: "completed", changes: [] };
  assert.deepEqual(rows([edit("1", "a.ts"), codex, edit("2", "a.ts")]), [["1"], ["codex"], ["2"]]);
});

test("failed edits stay standalone and never absorb or join a run", () => {
  assert.deepEqual(rows([edit("1", "a.ts"), edit("2", "a.ts", "failed"), edit("3", "a.ts")]), [["1"], ["2"], ["3"]]);
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
