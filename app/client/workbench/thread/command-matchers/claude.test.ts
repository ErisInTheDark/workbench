/* No exports. Protect native Claude tool semantics from structured arguments, never shell parsing. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getClaudeToolDisplay } from "./claude";

function item(tool: string, args: Record<string, string | number>): Extract<ThreadItem, { type: "dynamicToolCall" }> {
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
  assert.equal(getClaudeToolDisplay(item("Edit", { file_path: "src/a.ts" })), null);
  assert.equal(getClaudeToolDisplay({ ...item("Read", { file_path: "src/a.ts" }), namespace: "opencode" }), null);
});
