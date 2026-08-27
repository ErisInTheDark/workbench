/*
 * No production exports. Node tests protect exact recovery identity, content, and collision behavior. Keywords: thread, recovery, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import {
  WORKBENCH_THREAD_RECOVERY_MESSAGE,
  createWorkbenchQuestionnaireResponseInput,
  createWorkbenchThreadRecoveryId,
  createWorkbenchThreadRecoveryInput,
  isWorkbenchHiddenSystemSteerInput,
  isWorkbenchQuestionnaireResponseInput,
  isWorkbenchThreadRecoveryEligible,
  isWorkbenchThreadRecoveryInput,
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

test("manual recovery follows inactive Workbench lifecycle without competing with pending input", () => {
  const interruptedTurn = { completedAt: 1, durationMs: 1, error: null, id: "turn", items: [], itemsView: "full" as const, startedAt: 1, status: "interrupted" as const };
  const attention = { kind: "needsAttention", reason: "noActiveTurn", settled: false } as const;
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, attention, false), true);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, { kind: "stopped", reason: "userMarkedStopped", settled: false }, false), true);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, attention, true), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn" }, false), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, { kind: "completed", reason: "userCompleted", settled: false }, false), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, attention, false, "comment"), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [{ ...interruptedTurn, completedAt: null, status: "inProgress" }] }, attention, false), false);
});

test("only the exact single recovery text is recognized", () => {
  assert.equal(WORKBENCH_THREAD_RECOVERY_MESSAGE, "<wb:resume />");
  assert.equal(isWorkbenchThreadRecoveryInput(createWorkbenchThreadRecoveryInput()), true);
  assert.equal(isWorkbenchThreadRecoveryInput([{ text: `${WORKBENCH_THREAD_RECOVERY_MESSAGE} extra`, text_elements: [], type: "text" }]), false);
});

test("user messages hide exact recovery content regardless of provider identity", () => {
  const recoveryId = createWorkbenchThreadRecoveryId("candidate");
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ clientId: recoveryId })), true);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ id: `opencode:user:${recoveryId}` })), true);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem()), true);
  assert.equal(isWorkbenchThreadRecoveryUserMessage(userItem({ clientId: recoveryId, content: [{ text: "ordinary", text_elements: [], type: "text" }] })), false);
});

test("questionnaire response elements carry exact response JSON and are hidden system steers", () => {
  const input = createWorkbenchQuestionnaireResponseInput({ answers: { route: { answers: ["approved"] } } });
  const text = input[0]?.type === "text" ? input[0].text : "";
  assert.equal(isWorkbenchQuestionnaireResponseInput(input), true);
  assert.equal(isWorkbenchHiddenSystemSteerInput(input), true);
  assert.equal(isWorkbenchQuestionnaireResponseInput([{ text: `${text} extra`, text_elements: [], type: "text" }]), false);
});
