/*
 * Exports:
 * - No production exports; Node tests cover subagent wait output and empty questionnaire responses. Keywords: subagent, wait, questionnaire, output, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchUserInputRequest } from "workbench-shared/types";
import { buildWorkbenchApprovalPresentation } from "../approval-presentation.ts";
import {
  createEmptySubagentQuestionnaireResponse,
  renderSubagentQuestionnaireOutput,
  renderSubagentTurnOutput,
  renderSubagentWaitResultOutput,
} from "./subagent-output.ts";

const questionnaire: WorkbenchUserInputRequest = {
  id: "request-1",
  questions: [{
    allowOther: true,
    header: "Direction",
    id: "direction",
    isSecret: false,
    options: [
      { description: "Keep the current route.", label: "Continue" },
      { description: "Stop this branch.", label: "Stop" },
    ],
    question: "What should happen next?",
  }],
  submitLabel: "Send",
  summary: "Choose a direction.",
  title: "Direction needed",
};

function thread(items: Turn["items"]): { turns: Turn[] } {
  return { turns: [{
    id: "turn", items, status: "completed", itemsView: "full",
    error: null, startedAt: null, completedAt: null, durationMs: null,
  }] };
}

test("renders only trailing commentary before a questionnaire", () => {
  const output = renderSubagentQuestionnaireOutput(thread([
    { id: "old", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "Old commentary", type: "agentMessage" },
    { clientId: null, content: [], id: "user", type: "userMessage" },
    { id: "new-1", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "First trailing note", type: "agentMessage" },
    { id: "new-2", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "Second trailing note", type: "agentMessage" },
  ]), questionnaire);

  assert.doesNotMatch(output, /Old commentary/u);
  assert.match(output, /^First trailing note\n\nSecond trailing note/u);
  assert.match(output, /Direction\nWhat should happen next\?\n1\. Continue — Keep the current route\./u);
});

test("gives a parent what a child's approval asks and the choices it really has", () => {
  const longCommand = `git checkout -- ${"std/ts/restrictions.dx ".repeat(30)}end-of-command`;
  const command = renderSubagentQuestionnaireOutput(thread([]), buildWorkbenchApprovalPresentation({
    id: "approval-command",
    allowSession: true,
    subject: {
      kind: "command", command: longCommand, commandActions: [], cwd: "C:/git/app", justification: "Restore one file",
      networkTarget: "example.com", rememberable: true,
    },
  }));
  assert.ok(command.includes(longCommand));
  for (const fact of ["C:/git/app", "Restore one file", "example.com"]) assert.ok(command.includes(fact), fact);

  const patch = renderSubagentQuestionnaireOutput(thread([]), buildWorkbenchApprovalPresentation({
    id: "approval-patch",
    allowSession: false,
    subject: { kind: "patch", reason: "Fix the rule", grantRoot: null, paths: ["std/ts/restrictions.dx"] },
  }));
  assert.ok(patch.includes("std/ts/restrictions.dx"));

  for (const output of [command, patch]) {
    assert.match(output, /forward/u);
    assert.match(output, /deny/u);
    assert.doesNotMatch(output, /Allow once|Allow for session|Decline/u);
  }
});

test("renders final output and creates an explicitly empty response", () => {
  assert.equal(renderSubagentTurnOutput(thread([
    { id: "commentary", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "Working", type: "agentMessage" },
    { id: "final", memoryCitation: null, delivery: null, questions: null, phase: "final_answer", text: "Finished", type: "agentMessage" },
  ]), null), "Finished");
  assert.deepEqual(createEmptySubagentQuestionnaireResponse(questionnaire), {
    answers: { direction: { answers: [] } },
  });
});

test("leads with the thread error or interruption instead of empty output", () => {
  const partial = { id: "partial", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "Halfway", type: "agentMessage" } as const;
  const turnId = WorkbenchTurnIdSchema.parse("turn");
  const failed = { kind: "needsAttention", reason: "providerFailed", settled: false, turnId, error: "Selected model is at capacity." } as const;
  assert.equal(renderSubagentTurnOutput(thread([]), failed), "Thread error: Selected model is at capacity.");
  assert.equal(renderSubagentTurnOutput(thread([partial]), failed), "Thread error: Selected model is at capacity.\n\nHalfway");
  assert.match(renderSubagentTurnOutput(thread([partial]), { kind: "needsAttention", reason: "interrupted", settled: false, turnId }), /^Turn was interrupted\.[^]*\n\nHalfway$/u);
  assert.match(renderSubagentTurnOutput(thread([]), { ...failed, resumeAt: 5_000 }), /^Thread error: Selected model is at capacity\. .*resumes/u);
  assert.equal(renderSubagentTurnOutput(thread([partial]), null), "Halfway");
});

test("identifies multiplexed wait results while preserving singular output", () => {
  assert.equal(renderSubagentWaitResultOutput({
    multiplexed: false,
    name: "Momo",
    outcome: "finished",
    output: "Finished",
    threadId: "child-1",
  }), "Finished");
  assert.equal(renderSubagentWaitResultOutput({
    multiplexed: true,
    name: "Momo",
    outcome: "needs-interaction",
    output: "Choose a direction.",
    threadId: "child-1",
  }), "Subagent Momo (child-1) needs interaction.\n\nChoose a direction.");
  assert.equal(renderSubagentWaitResultOutput({
    multiplexed: true,
    name: "Yuzu",
    outcome: "finished",
    output: "",
    threadId: "child-2",
  }), "Subagent Yuzu (child-2) finished its current turn.");
});
