/*
 * Exports:
 * - No production exports; Node tests cover native steer-history ordering and exact rendering. Keywords: steer, history, identity, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "../../types.ts";
import { applySteerHistoryToThread } from "./thread-steer-history.ts";

function entry(id: string, sequence: number, status: WorkbenchSteerHistoryEntry["status"]): WorkbenchSteerHistoryEntry {
  return {
    attemptedAt: 1, canonicalItemId: null, clientUserMessageId: id, dispatchSequence: sequence, entryKey: `turn-steer-client:${id}`,
    error: status === "failed" ? "failed" : null, input: [{ text: id, text_elements: [], type: "text" }], requestId: id,
    resolvedAt: status === "pending" ? null : 2, status, threadId: "thread", turnId: "turn",
  };
}

function thread(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness: "codex", id: "thread", isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "active", tokenUsage: null, turnHistory: [], unreadBadge: null,
    turns: [{ completedAt: null, durationMs: null, error: null, id: "turn", items: [], itemsView: "full", startedAt: 1, status: "inProgress" }], updatedAt: 1,
  };
}

test("native pending history uses dispatch sequence rather than UUID order", () => {
  const projected = applySteerHistoryToThread(thread(), [entry("z", 0, "pending"), entry("a", 1, "pending")]);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.type === "userMessage" ? item.clientId : null), ["z", "a"]);
});

test("sent history is not synthetic while exact terminal evidence is", () => {
  const projected = applySteerHistoryToThread(thread(), [entry("sent", 0, "sent"), entry("failed", 1, "failed")]);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.type === "userMessage" ? item.clientId : null), ["failed"]);
});

test("native client identity suppresses terminal history after an item id alias changes", () => {
  const source = thread();
  source.turns[0]!.items = [{
    clientId: "failed",
    content: [{ text: "failed", text_elements: [], type: "text" }],
    id: "canonical-new",
    type: "userMessage",
  }];
  const failed = { ...entry("failed", 0, "failed"), canonicalItemId: "canonical-old" };
  const projected = applySteerHistoryToThread(source, [failed]);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["canonical-new"]);
});

test("legacy history retains attempted-time ordering and content compatibility", () => {
  const legacyA = { ...entry("z", 0, "pending"), attemptedAt: 1, clientUserMessageId: null, dispatchSequence: null, entryKey: "legacy-z" };
  const legacyB = { ...entry("a", 1, "pending"), attemptedAt: 2, clientUserMessageId: null, dispatchSequence: null, entryKey: "legacy-a" };
  const projected = applySteerHistoryToThread(thread(), [legacyB, legacyA]);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), [
    "workbench:steer-history:pending:thread:legacy-z",
    "workbench:steer-history:pending:thread:legacy-a",
  ]);

  projected.turns[0]!.items = [{ clientId: null, content: legacyA.input, id: "canonical", type: "userMessage" }];
  assert.deepEqual(applySteerHistoryToThread(projected, [legacyA]).turns[0]?.items.map((item) => item.id), ["canonical"]);
});
