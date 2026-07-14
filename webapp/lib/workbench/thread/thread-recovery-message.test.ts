/*
 * No production exports. Node tests protect exact recovery identity, content, and collision behavior. Keywords: thread, recovery, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import {
  WORKBENCH_THREAD_RECOVERY_MESSAGE,
  createWorkbenchThreadRecoveryId,
  createWorkbenchThreadRecoveryInput,
  isWorkbenchThreadRecoveryInput,
  isWorkbenchInterruptedThreadRecoveryEligible,
  isWorkbenchThreadRecoveryUserMessage,
} from "./thread-recovery-message";

function userItem(overrides: Partial<Extract<ThreadItem, { type: "userMessage" }>> = {}) {
  return {
    clientId: null,
    content: createWorkbenchThreadRecoveryInput(),
    id: "user",
    type: "userMessage" as const,
    ...overrides,
  };
}

test("deterministic seeds create stable provider-safe recovery ids", () => {
  assert.equal(createWorkbenchThreadRecoveryId("thread:turn"), createWorkbenchThreadRecoveryId("thread:turn"));
  assert.notEqual(createWorkbenchThreadRecoveryId("thread:turn"), createWorkbenchThreadRecoveryId("thread:other"));
});

test("manual recovery is eligible only for inactive interrupted Codex and OpenCode threads", () => {
  const interruptedTurn = { completedAt: 1, durationMs: 1, error: null, id: "turn", items: [], itemsView: "full" as const, startedAt: 1, status: "interrupted" as const };
  assert.equal(isWorkbenchInterruptedThreadRecoveryEligible({ harness: "codex", turns: [interruptedTurn] }), true);
  assert.equal(isWorkbenchInterruptedThreadRecoveryEligible({ harness: "opencode", turns: [interruptedTurn] }), true);
  assert.equal(isWorkbenchInterruptedThreadRecoveryEligible({ harness: "copilot", turns: [interruptedTurn] }), false);
  assert.equal(isWorkbenchInterruptedThreadRecoveryEligible({ harness: "codex", turns: [interruptedTurn] }, "comment"), false);
  assert.equal(isWorkbenchInterruptedThreadRecoveryEligible({ harness: "codex", turns: [{ ...interruptedTurn, completedAt: null, status: "inProgress" }] }), false);
});

test("only the exact single recovery text is recognized", () => {
  assert.equal(isWorkbenchThreadRecoveryInput(createWorkbenchThreadRecoveryInput()), true);
  assert.equal(isWorkbenchThreadRecoveryInput([{ text: `${WORKBENCH_THREAD_RECOVERY_MESSAGE} extra`, text_elements: [], type: "text" }]), false);
});

test("user messages require both exact content and a provider recovery marker", () => {
  const recoveryId = createWorkbenchThreadRecoveryId("candidate");
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ clientId: recoveryId })), true);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ id: `opencode:user:${recoveryId}` })), true);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem()), false);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ clientId: recoveryId, content: [{ text: "ordinary", text_elements: [], type: "text" }] })), false);
});
