/* No exports. Protect unsupported native media rejection at raw extraction boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractItem, extractThread, extractTurn } from "./codex-transcript-normalizers.ts";

test("raw item, turn and thread extraction reject file-backed images without mutating evidence", () => {
  const item = { type: "userMessage", id: "input", clientId: null, content: [
    { type: "text", text: "surrounding text", text_elements: [] },
    { type: "image", fileId: "private-file" },
  ] };
  const turn = { id: "turn", items: [item], itemsView: "full", status: "completed",
    error: null, startedAt: null, completedAt: null, durationMs: null };
  const thread = { id: "thread", turns: [turn] };
  const packets = [
    { params: { item } },
    { params: { turn } },
    { result: { thread } },
    { params: { thread } },
  ];
  const original = structuredClone(packets);
  for (const [extract, packet] of [
    [extractItem, packets[0]],
    [extractTurn, packets[1]],
    [extractThread, packets[2]],
    [extractThread, packets[3]],
  ] as const) {
    assert.throws(() => extract(packet), error => error instanceof Error && !error.message.includes("private-file"));
  }
  assert.deepEqual(packets, original);
});
