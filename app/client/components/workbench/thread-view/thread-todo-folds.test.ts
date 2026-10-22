/*
 * No production exports. Tests protect todo card folding: a completed listing folds into the add or removal right after
 * it, back-to-back todo cards stitch into one, and only todo cards stitch with todo cards. MCP and CLI calls fold alike.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { buildActivityRuns } from "./thread-activity-runs";
import { foldCardBlocks } from "./thread-card-folds";
import { buildRenderableBlocks, getRenderableBlockItems, type CommandItem, type ThreadRenderableBlock } from "./thread-render-blocks";

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function mcp(id: string, tool: string, args: McpItem["arguments"] = {}, status: McpItem["status"] = "completed"): McpItem {
  return { id, type: "mcpToolCall", server: "wb", tool, arguments: args, status, result: null,
    error: status === "failed" ? { message: "nope" } : null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}
function cli(id: string, command: string): CommandItem {
  return { id, type: "commandExecution", command, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: 0, aggregatedOutput: "", pluginId: null, processId: null, scriptPath: null, source: "agent", status: "completed" };
}
function commentary(id: string): ThreadItem {
  return { type: "agentMessage", id, text: id, phase: "commentary", memoryCitation: null, delivery: null, questions: null };
}

const fold = (items: ThreadItem[]) => foldCardBlocks(buildActivityRuns(buildRenderableBlocks(items)));
const ids = (block: ThreadRenderableBlock | undefined) => block ? getRenderableBlockItems(block).map(item => item.id) : null;

test("a listing folds into the removal after it, and the add after that stitches on as one card", () => {
  const blocks = fold([mcp("list", "todo"), mcp("remove", "todo_remove", { ids: [1] }), mcp("add", "todo", { text: "Next — later" })]);
  assert.equal(blocks.length, 1);
  const [card] = blocks;
  if (card?.kind !== "cardSequence") return assert.fail("expected one stitched card");
  const [removal, add] = card.blocks;
  if (removal?.kind !== "cardHistory") return assert.fail("expected the removal to open onto the listing");
  assert.deepEqual(removal.history.flatMap(segment => "items" in segment ? segment.items.map(item => item.id) : []), ["list"]);
  assert.deepEqual(ids(removal.success), ["remove"]);
  assert.deepEqual(ids(add), ["add"]);
});

test("CLI todo calls fold like MCP calls", () => {
  const [card, ...rest] = fold([cli("list", "wb todo"), cli("add", "wb todo --required -- Fix it — later")]);
  assert.equal(rest.length, 0);
  assert.equal(card?.kind, "cardHistory");
  assert.deepEqual(ids(card), ["list", "add"]);
});

test("a failed listing, or one nothing changes after, stays its own card", () => {
  const kinds = (items: ThreadItem[]) => fold(items).map(block => block.kind);
  assert.deepEqual(kinds([mcp("list", "todo"), commentary("none left")]), ["item", "agentCommentarySequence"]);
  const [stitched] = fold([mcp("list", "todo", {}, "failed"), mcp("add", "todo", { text: "Next — later" })]);
  assert.deepEqual(stitched?.kind === "cardSequence" ? stitched.blocks.map(block => block.kind) : null, ["item", "item"]);
});

test("todo cards never stitch with arc cards", () => {
  assert.deepEqual(fold([mcp("add", "todo", { text: "Next — later" }), mcp("stacked", "git_arc_stack")]).map(block => block.kind), ["item", "item"]);
});
