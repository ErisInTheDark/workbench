/* No production exports. Tests protect Copilot user-input delivery notification semantics. */
import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

import { applyCopilotEvent, createThreadState } from "./copilot-thread-state";
import type { JsonRpcNotification } from "./bridge-types";

function userMessage(content: string): Extract<SessionEvent, { type: "user.message" }> {
  return {
    data: { content },
    id: "00000000-0000-4000-8000-000000000001",
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    type: "user.message",
  };
}

function activeState() {
  const state = createThreadState("thread", null, "C:/repo");
  state.currentTurnId = "turn";
  state.thread.turns = [{
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn",
    items: [],
    itemsView: "full",
    startedAt: 1,
    status: "inProgress",
  }];
  return state;
}

test("live active-turn user messages emit delivery while replay and pending input stay silent", () => {
  const notifications: JsonRpcNotification[] = [];
  const live = activeState();
  applyCopilotEvent(live, userMessage("delivered steer"), true, (notification) => notifications.push(notification));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.method, "item/completed");
  assert.deepEqual(notifications[0]?.params, {
    item: {
      clientId: null,
      content: [{ text: "delivered steer", text_elements: [], type: "text" }],
      id: (notifications[0]?.params as { item: { id: string } }).item.id,
      type: "userMessage",
    },
    threadId: "thread",
    turnId: "turn",
  });

  applyCopilotEvent(activeState(), userMessage("history"), false, (notification) => notifications.push(notification));
  const pending = createThreadState("pending", null, "C:/repo");
  applyCopilotEvent(pending, userMessage("first message"), true, (notification) => notifications.push(notification));
  assert.equal(notifications.length, 1);
  assert.equal(pending.pendingUserInputs.length, 1);
});
