/* No production exports. Tests protect the per-string bound on admitted item text. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { boundTranscriptItem, MAX_TRANSCRIPT_ITEM_STRING_CHARS } from "./transcript-item-bounds.ts";

function toolResult(text: string): ThreadItem {
  return {
    id: "call", type: "mcpToolCall", server: "wb", tool: "rg", status: "completed", arguments: { args: ["x"] },
    appContext: null, pluginId: null, readOnlyHint: true,
    result: { content: [{ type: "text", text }], structuredContent: null, _meta: null }, error: null, durationMs: 1,
  } as unknown as ThreadItem;
}

test("an oversized tool result keeps its head and tail with an omission marker", () => {
  const text = `HEAD${"x".repeat(5 * 1024 * 1024)}TAIL`;
  const bounded = boundTranscriptItem(toolResult(text));
  const stored = bounded.type === "mcpToolCall" ? (bounded.result!.content[0] as { text: string }).text : "";
  assert.ok(stored.length < MAX_TRANSCRIPT_ITEM_STRING_CHARS + 200);
  assert.ok(stored.startsWith("HEAD") && stored.endsWith("TAIL"));
  assert.match(stored, /Workbench omitted [\d,]+ characters/u);
});

test("items within the bound and inline images pass through as the same object", () => {
  const small = toolResult("fine");
  assert.equal(boundTranscriptItem(small), small);
  const image = toolResult(`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`);
  assert.equal(boundTranscriptItem(image), image);
});
