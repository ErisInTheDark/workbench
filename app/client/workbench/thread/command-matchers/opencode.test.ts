/* No exports. Protect native tool semantics without parsing executable source. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getOpenCodeToolDisplay, getOpenCodeFileChanges } from "./opencode";
import { getWorkbenchMcpCommandDisplay } from "./workbench-mcp";

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

test("historical WB calls use the shared matcher without inventing child results", () => {
  const args = { args: ["needle", "src"] };
  const shared = getWorkbenchMcpCommandDisplay({ server: "wb", tool: "rg", argumentsValue: args });
  assert.ok(shared);
  const wrapper = { ...item("execute", { code: "opaque" }), metadata: { toolCalls: [
    { tool: "wb.rg", input: args, status: "completed" },
    { tool: "wb.rg", input: args, status: "running" },
    { tool: "wb.rg", input: args, status: "error" },
    { tool: "wb.git_arc_status", input: {}, status: "completed" },
  ] } };
  const before = structuredClone(wrapper);
  const display = getOpenCodeToolDisplay(wrapper);
  assert.deepEqual(display?.detailRows?.slice(0, 3).map(row => row.summaryParts),
    [shared.summaryParts, shared.ongoingSummaryParts, shared.summaryParts]);
  assert.deepEqual(display?.detailRows?.map(row => row.state), ["completed", "inProgress", "failed", "completed"]);
  assert.deepEqual(wrapper, before);
});

test("failed native edits retain attempted targets without applied counts", () => {
  const failed = { ...item("edit", { path: "src/failed.ts", oldString: "old", newString: "new" }),
    status: "failed" as const, success: false };
  const changes = getOpenCodeFileChanges(failed);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.change.path, "src/failed.ts");
  assert.equal(changes[0]?.danger, true);
  assert.equal(changes[0]?.change.diff, "");
});

test("failed patch targets retain create, delete and move intent without parsing executable source", () => {
  const patchText = "*** Begin Patch\n*** Add File: new.ts\n+new\n*** Delete File: old.ts\n*** Update File: from.ts\n*** Move to: to.ts\n@@\n-old\n+new\n*** End Patch";
  const failed = { ...item("patch", { patchText }),
    status: "failed" as const, success: false };
  const entries = getOpenCodeFileChanges(failed);
  assert.deepEqual(entries.map(entry => [entry.change.path, entry.change.kind]), [
    ["new.ts", { type: "add" }], ["old.ts", { type: "delete" }],
    ["from.ts", { type: "update", move_path: "to.ts" }],
  ]);
  assert.ok(entries.every(entry => entry.danger && entry.change.diff === ""));
  assert.deepEqual(getOpenCodeFileChanges(item("execute", { code: patchText })), []);
});
