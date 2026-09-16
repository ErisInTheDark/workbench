/*
 * No production exports. Node tests protect recovery identity, classification, and collision behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import { createWorkbenchActivatedSkillsInput } from "./thread-activated-skills.ts";
import { unwrapWorkbenchSteerDisplayInput } from "./thread-steer-display.ts";
import {
  WORKBENCH_THREAD_RECOVERY_MESSAGE,
  WORKBENCH_UNFINISHED_TURN_MESSAGE,
  createWorkbenchQuestionnaireResponseInput,
  createWorkbenchThreadRecoveryId,
  createWorkbenchThreadRecoveryInput,
  createWorkbenchUnfinishedTurnInput,
  isWorkbenchHiddenSystemSteerInput,
  isWorkbenchQuestionnaireResponseInput,
  isWorkbenchThreadRecoveryEligible,
  isWorkbenchThreadRecoveryInput,
  isWorkbenchThreadRecoveryUserMessage,
  isWorkbenchUnfinishedTurnInput,
} from "./thread-recovery-message.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchTurnId: {
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

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
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, false), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, { kind: "completed", reason: "userCompleted", settled: false }, false), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [interruptedTurn] }, attention, false, "comment"), false);
  assert.equal(isWorkbenchThreadRecoveryEligible({ turns: [{ ...interruptedTurn, completedAt: null, status: "inProgress" }] }, attention, false), false);
});

test("recovery control inputs reject extra content outside their reserved envelope", () => {
  assert.equal(isWorkbenchThreadRecoveryInput(createWorkbenchThreadRecoveryInput()), true);
  assert.equal(isWorkbenchThreadRecoveryInput(createWorkbenchUnfinishedTurnInput()), true);
  assert.equal(isWorkbenchUnfinishedTurnInput(createWorkbenchUnfinishedTurnInput()), true);
  assert.equal(isWorkbenchHiddenSystemSteerInput(createWorkbenchUnfinishedTurnInput()), true);
  assert.equal(isWorkbenchThreadRecoveryInput([{ text: `${WORKBENCH_THREAD_RECOVERY_MESSAGE} extra`, text_elements: [], type: "text" }]), false);
  assert.equal(isWorkbenchUnfinishedTurnInput([{ text: `${WORKBENCH_UNFINISHED_TURN_MESSAGE} extra`, text_elements: [], type: "text" }]), false);
});

test("reserved resume wrappers stay hidden regardless of body wording", () => {
  for (const body of ["", "New recovery wording.", "First part.\n</wb:resume>\nStill part of the reserved body."]) {
    const wrapped = [{ text: `<wb:resume>\n${body}\n</wb:resume>`, text_elements: [], type: "text" as const }];
    assert.equal(isWorkbenchThreadRecoveryInput(wrapped), true);
    assert.equal(isWorkbenchUnfinishedTurnInput(wrapped), true);
    assert.equal(isWorkbenchHiddenSystemSteerInput(wrapped), true);
  }
  const input = [{
    text: "<wb:resume>\nNew recovery wording.\n</wb:resume>",
    text_elements: [],
    type: "text" as const,
  }];
  assert.equal(isWorkbenchThreadRecoveryInput([input[0]!, { text: "ordinary", text_elements: [], type: "text" }]), false);
  assert.equal(isWorkbenchThreadRecoveryInput([{ ...input[0]!, text: `before\n${input[0]!.text}` }]), false);
  assert.equal(isWorkbenchThreadRecoveryInput([{ ...input[0]!, text: input[0]!.text.replace(/<\/wb:resume>$/u, "") }]), false);
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

test("questionnaire responses remain hidden with activated skill transport", () => {
  const response = createWorkbenchQuestionnaireResponseInput({ answers: { route: { answers: ["approved"] } } });
  const skill = createWorkbenchActivatedSkillsInput("skill instructions");
  for (const input of [[...response, skill], [skill, ...response]]) {
    assert.equal(isWorkbenchQuestionnaireResponseInput(input), true);
    assert.equal(isWorkbenchHiddenSystemSteerInput(input), true);
  }
});

test("skill transport does not hide other input alongside questionnaire responses", () => {
  const response = createWorkbenchQuestionnaireResponseInput({ answers: { route: { answers: ["approved"] } } });
  const skill = createWorkbenchActivatedSkillsInput("skill instructions");
  const ordinary = { text: "additional user message", text_elements: [], type: "text" as const };
  const image = { type: "image" as const, url: "https://example.com/image.png" };
  const malformed = { text: "<wb:questionnaire-response>\nnot JSON\n</wb:questionnaire-response>", text_elements: [], type: "text" as const };
  for (const input of [[...response, ordinary, skill], [...response, image, skill], [malformed, skill], [skill]]) {
    assert.equal(isWorkbenchQuestionnaireResponseInput(input), false);
    assert.equal(isWorkbenchHiddenSystemSteerInput(input), false);
  }
});

test("mixed questionnaire response transport preserves only visible siblings for display", () => {
  const response = createWorkbenchQuestionnaireResponseInput({ answers: { route: { answers: ["approved"] } } });
  const ordinary = { text: "visible note", text_elements: [], type: "text" as const };
  const image = { type: "image" as const, url: "https://example.com/image.png" };
  const malformed = { text: "<wb:questionnaire-response>\nnot JSON\n</wb:questionnaire-response>", text_elements: [], type: "text" as const };

  assert.deepEqual(unwrapWorkbenchSteerDisplayInput([...response, image, ordinary]), [image, ordinary]);
  assert.deepEqual(unwrapWorkbenchSteerDisplayInput([malformed, image]), [malformed, image]);
});
