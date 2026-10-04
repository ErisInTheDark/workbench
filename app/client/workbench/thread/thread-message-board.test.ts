/*
 * No production exports. Tests protect message board history: incoming/outgoing split, attribution, simple versions, skipped items and ordering.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchAgentMessageOutput, createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { deriveThreadMessageBoardHistory } from "./thread-message-board";

function user(id: string, text: string): ThreadItem {
  return { clientId: null, content: [{ text, text_elements: [], type: "text" }], id, type: "userMessage" };
}

function agent(id: string, text: string, phase: "commentary" | "final_answer" | null): ThreadItem {
  return { delivery: null, id, memoryCitation: null, phase, questions: null, text, type: "agentMessage" };
}

function messageCall(id: string, args: Record<string, string | boolean>, failed = false): ThreadItem {
  return {
    appContext: null, arguments: args, durationMs: null, error: failed ? { message: "rejected" } : null, id,
    pluginId: null, readOnlyHint: null, result: null, server: "wb", status: failed ? "failed" : "completed", tool: "message", type: "mcpToolCall",
  };
}

function turn(id: string, items: ThreadItem[], startedAt: number) {
  return { completedAt: startedAt + 5, id, items, startedAt, status: "completed" as const };
}

test("message history splits incoming from the thread agent's own messages, in transcript order", () => {
  const sender = { message: "Use `abc12` for the rebase.", senderName: "parent agent", senderThreadId: "parent" };
  const history = deriveThreadMessageBoardHistory([
    turn("t1", [
      user("prompt", "Investigate the cache."),
      agent("note", "Looking around.", "commentary"),
      messageCall("sent", { message: "Found `staleKey`.", parent: true, userVisibleSimpleVersion: "Found the stale cache." }),
      messageCall("failed", { message: "Lost.", parent: true, userVisibleSimpleVersion: "Lost." }, true),
      agent("final", "All done.<wb:end />", "final_answer"),
    ], 10),
    turn("t2", [
      user("steer", createWorkbenchAgentMessageText({ ...sender, userVisibleSimpleVersion: "Rebase on the new commit." })),
      { ...createWorkbenchAgentMessageOutput({ ...sender, message: "Native." }), id: "native", type: "functionCallOutput" },
    ], 20),
  ], [{ itemTimeline: [{ completedAt: null, firstSeenAt: 12_000, itemId: "sent", lastSeenAt: null, startedAt: 12_500 }], turnId: "t1" }]);

  assert.deepEqual(history.map(({ direction, id }) => [direction, id]), [
    ["incoming", "prompt"], ["outgoing", "sent"], ["outgoing", "final"], ["incoming", "steer"], ["incoming", "native"],
  ]);
  assert.deepEqual(history[1], {
    direction: "outgoing", id: "sent", markdown: "Found `staleKey`.", target: { kind: "parent", value: null },
    timestampSeconds: 12, userVisibleSimpleVersion: "Found the stale cache.",
  });
  assert.equal(history[2]?.markdown, "All done.");
  assert.equal(history[2]?.timestampSeconds, 15);
  assert.deepEqual(history[3], {
    direction: "incoming", id: "steer", markdown: sender.message, sender: { name: "parent agent", threadId: "parent" },
    timestampSeconds: 20, userVisibleSimpleVersion: "Rebase on the new commit.",
  });
  assert.equal(history[4]?.userVisibleSimpleVersion, null);
});

test("phase-less providers report only their last completed-turn message as the final answer", () => {
  const history = deriveThreadMessageBoardHistory([
    turn("t1", [agent("draft", "Thinking.", null), agent("last", "Result.", null)], 1),
    { ...turn("t2", [agent("live", "Still going.", null)], 2), status: "inProgress" as const },
  ]);
  assert.deepEqual(history.map(({ id }) => id), ["last"]);
});
