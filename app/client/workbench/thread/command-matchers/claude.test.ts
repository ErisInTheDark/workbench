/* No exports. Protect native Claude tool semantics from structured arguments, never shell parsing. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getClaudeToolDisplay } from "./claude";
import { getNativeFileChanges, isNativeFileOperation } from "./native-file-changes";

type NativeItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

function item(tool: string, args: Record<string, string | number>): NativeItem {
  return { type: "dynamicToolCall", id: "native", namespace: "claude", tool, arguments: args,
    status: "completed", success: true, contentItems: [], durationMs: 10 };
}

test("Claude Read, Grep, and Glob keep paths and patterns structured", () => {
  const read = getClaudeToolDisplay(item("Read", { file_path: "src/has spaces.ts", offset: 12 }));
  assert.deepEqual(read?.summaryParts.filter(part => part.type === "path").map(part => part.path), ["src/has spaces.ts"]);
  assert.equal(read?.summaryStats.readFiles, 1);
  const grep = getClaudeToolDisplay(item("Grep", { pattern: "a|b", path: "src", output_mode: "content" }));
  assert.ok(grep?.summaryParts.some(part => part.type === "pattern" && part.pattern === "a|b" && part.syntax === "regex"));
  assert.ok(grep?.summaryParts.some(part => part.type === "path" && part.path === "src"));
  const glob = getClaudeToolDisplay(item("Glob", { pattern: "**/*.ts" }));
  assert.ok(glob?.summaryParts.some(part => part.type === "pattern" && part.syntax === "literal"));
  assert.ok(glob?.summaryParts.some(part => part.type === "path" && part.path === "."), "a missing search root means the working directory");
});

test("wrong argument shapes and other namespaces fall back to the generic tool row", () => {
  assert.equal(getClaudeToolDisplay(item("Read", { path: "opencode-shape" })), null);
  assert.equal(getClaudeToolDisplay(item("Grep", { path: "src" })), null);
  assert.equal(getClaudeToolDisplay({ ...item("Read", { file_path: "src/a.ts" }), namespace: "opencode" }), null);
});

const rows = (value: NativeItem) => getNativeFileChanges(value).map(entry => ({
  path: entry.change.path, kind: entry.change.kind.type, diff: entry.change.diff,
  danger: entry.danger, failureKind: entry.failureKind,
}));

test("Edit and Write become file changes carrying the effective diff Claude applied", () => {
  const edit = { ...item("Edit", { file_path: "src/a.ts", old_string: "b", new_string: "B" }),
    metadata: { fileChange: { kind: "update", diff: "@@ -1,2 +1,2 @@\n a\n-b\n+B" } } };
  assert.ok(isNativeFileOperation(edit));
  assert.deepEqual(rows(edit), [{ path: "src/a.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n a\n-b\n+B", danger: false, failureKind: undefined }]);
  const overwrite = { ...item("Write", { file_path: "old.ts", content: "x" }),
    metadata: { fileChange: { kind: "update", diff: "@@ -1 +1 @@\n-y\n+x" } } };
  assert.equal(rows(overwrite)[0]?.kind, "update", "an applied overwrite shows as the edit it really was");
});

test("before and without applied evidence, Write reads as a create and Edit as an edit", () => {
  const writing = { ...item("Write", { file_path: "new.ts", content: "x" }), status: "inProgress" as const, success: null };
  assert.deepEqual(rows(writing), [{ path: "new.ts", kind: "add", diff: "", danger: false, failureKind: undefined }]);
  const legacy = { ...item("Edit", { file_path: "a.ts" }), metadata: { fileChange: { kind: "rename", diff: 4 } } };
  assert.deepEqual(rows(legacy), [{ path: "a.ts", kind: "update", diff: "", danger: false, failureKind: undefined }]);
  assert.deepEqual(getNativeFileChanges(item("Edit", { path: "opencode-shape" })), []);
  assert.equal(isNativeFileOperation(item("Read", { file_path: "a.ts" })), false);
});

test("claim denials stay distinguishable from other failed edits", () => {
  const failed = (metadata?: object): NativeItem => ({ ...item("Edit", { file_path: "a.ts" }),
    status: "failed", success: false, ...(metadata ? { metadata: metadata as never } : {}) });
  assert.deepEqual(rows(failed({ workbenchFailureKind: "unclaimed" })),
    [{ path: "a.ts", kind: "update", diff: "", danger: true, failureKind: "unclaimed" }]);
  assert.equal(rows(failed())[0]?.failureKind, undefined);
});
