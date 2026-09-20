/* No exports. Protect native tool semantics without parsing executable source. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getOpenCodeToolDisplay, getOpenCodeFileChanges } from "./opencode";

function item(tool: string, args: Record<string, string | number>): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return { type: "dynamicToolCall", id: "native", namespace: "opencode", tool, arguments: args,
    status: "completed", success: true, contentItems: [], durationMs: 10 };
}

test("native paths and search patterns remain structured rather than shell-parsed", () => {
  const read = getOpenCodeToolDisplay(item("read", { path: "src/has spaces.ts", offset: 12 }));
  assert.ok(read);
  assert.deepEqual(read.summaryParts.filter(part => part.type === "path").map(part => part.path), ["src/has spaces.ts"]);
  const grep = getOpenCodeToolDisplay(item("grep", { path: "src", pattern: "a|b" }));
  assert.ok(grep?.summaryParts.some(part => part.type === "pattern" && part.pattern === "a|b"));
  assert.equal(getOpenCodeToolDisplay(item("read", { filePath: "wrong-shape" })), null);
  assert.equal(getOpenCodeToolDisplay(item("execute", { code: "await tools.read({path:'invented'})" })), null);
  assert.equal(getOpenCodeToolDisplay({ ...item("read", { path: "src/a" }), namespace: "other" }), null);
});

test("final file evidence preserves failure and rejects malformed metadata", () => {
  const failed = { ...item("patch", {}), success: false, status: "failed" as const,
    metadata: { files: [{ file: "a.ts", patch: "+new", additions: 1, deletions: 0, status: "modified" }] } };
  const changes = getOpenCodeFileChanges(failed);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.change.diff, "+new");
  assert.equal(changes[0]?.danger, true);
  assert.deepEqual(getOpenCodeFileChanges({ ...failed, metadata: { files: [{ file: 42 }] } }), []);
});

test("patch summaries use explicit file headers and discovery summaries retain mixed child states", () => {
  const patch = getOpenCodeToolDisplay(item("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch" }));
  assert.ok(patch?.summaryParts.some(part => part.type === "path" && part.path === "src/a.ts"));
  const discovery = getOpenCodeToolDisplay({ ...item("execute", { code: "opaque" }), metadata: { toolCalls: [
    { tool: "search", input: { query: "tools for git" }, status: "completed" },
    { tool: "read", input: { path: "src/a.ts" }, status: "running" },
    { tool: "custom", input: {}, status: "error" },
  ] } });
  assert.deepEqual(discovery?.detailRows?.map(row => row.state), ["completed", "inProgress", "failed"]);
  assert.ok(discovery?.summaryText.includes("tools for git"));
});
