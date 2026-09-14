/*
 * Exports:
 * - No production exports; Node tests cover subagent wait output and empty questionnaire responses. Keywords: subagent, wait, questionnaire, output, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { WorkbenchUserInputRequest } from "workbench-shared/types";
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

function thread(items: Thread["turns"][number]["items"]): Thread {
  return { turns: [{ items, status: "completed" }] } as Thread;
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

test("renders final output and creates an explicitly empty response", () => {
  assert.equal(renderSubagentTurnOutput(thread([
    { id: "commentary", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "Working", type: "agentMessage" },
    { id: "final", memoryCitation: null, delivery: null, questions: null, phase: "final_answer", text: "Finished", type: "agentMessage" },
  ])), "Finished");
  assert.deepEqual(createEmptySubagentQuestionnaireResponse(questionnaire), {
    answers: { direction: { answers: [] } },
  });
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
