/* No exports. Protect rejection of unsupported media before steer parsing or reconciliation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import {
  createSteerHistoryEntryFromRequest,
  updateMatchingPendingSteerEntriesForUserMessage,
  updatePendingSteerEntriesForInterruptedTurn,
} from "./codex-transcript-steer-history.ts";

test("native image framing does not stop a pending steer from matching its delivered message", () => {
  const input = [{ type: "image" as const, url: "data:image/png;base64,AAAA" }];
  const entry = createSteerHistoryEntryFromRequest({
    id: "steer", method: "turn/steer", params: { threadId: "thread", expectedTurnId: "turn", input },
  });
  assert.ok(entry);
  const item: Extract<ThreadItem, { type: "userMessage" }> = {
    type: "userMessage", id: "input", clientId: null, content: [
      { type: "text", text: '<wb:attachment id="attach:1">', text_elements: [] },
      ...input, { type: "text", text: "</wb:attachment>", text_elements: [] },
    ],
  };
  assert.equal(updateMatchingPendingSteerEntriesForUserMessage([entry], item, 10)[0]?.status, "sent");
  assert.equal(updatePendingSteerEntriesForInterruptedTurn([entry], {
    id: "turn", items: [item], itemsView: "full", status: "interrupted",
    error: null, startedAt: null, completedAt: null, durationMs: null,
  }, 10)[0]?.status, "sent");
});

test("steer parsing and reconciliation cannot silently discard a file-backed image", () => {
  const item: Extract<ThreadItem, { type: "userMessage" }> = {
    type: "userMessage", id: "input", clientId: null, content: [
      { type: "text", text: "look here", text_elements: [] },
      { type: "image", fileId: "private-file" },
    ],
  };
  const entry = createSteerHistoryEntryFromRequest({
    id: "steer", method: "turn/steer",
    params: { threadId: "thread", expectedTurnId: "turn",
      input: [{ type: "text", text: "look here", text_elements: [] }] },
  });
  assert.ok(entry);
  for (const action of [
    () => createSteerHistoryEntryFromRequest({
      id: "unsupported", method: "turn/steer",
      params: { threadId: "thread", expectedTurnId: "turn", input: item.content },
    }),
    () => updateMatchingPendingSteerEntriesForUserMessage([entry], item, 10),
    () => updatePendingSteerEntriesForInterruptedTurn([entry], {
      id: "turn", items: [item], itemsView: "full", status: "interrupted",
      error: null, startedAt: null, completedAt: null, durationMs: null,
    }, 10),
  ]) {
    assert.throws(action, error => error instanceof Error && !error.message.includes("private-file"));
  }
  assert.equal(entry.status, "pending");
});
