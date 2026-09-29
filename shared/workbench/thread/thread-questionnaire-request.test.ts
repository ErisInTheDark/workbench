/*
 * No production exports. Tests protect questionnaire repair and assembly invariants: deterministic answer keys, no question truncation, the compact-display title contract, and approval decision recognizability. Keywords: questionnaire, repair, request, approval, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkbenchApprovalRequest,
  buildWorkbenchQuestionnaireRequest,
  repairQuestionnaireQuestion,
} from "./thread-questionnaire-request.ts";
import {
  hasWorkbenchApprovalDecisionSelection,
  WORKBENCH_APPROVAL_DECISION_QUESTION_ID,
  WORKBENCH_APPROVAL_DECLINE_LABEL,
} from "./thread-user-input-requests.ts";

test("repair generates deterministic answer keys and drops unusable questions", () => {
  assert.equal(repairQuestionnaireQuestion(2, { id: "", options: [], question: "go?" })?.id, "question-3");
  assert.equal(repairQuestionnaireQuestion(0, { id: "My Route!", options: [], question: "go?" })?.id, "my-route");
  assert.equal(repairQuestionnaireQuestion(1, { header: "Route", options: [] })?.question, "Route");
  assert.equal(
    repairQuestionnaireQuestion(0, { header: "", question: "", options: [{ label: "  ", description: "" }] }),
    null,
  );
});

test("questionnaire requests keep every question and clean option labels", () => {
  const request = buildWorkbenchQuestionnaireRequest({
    id: "request",
    questions: [
      { question: "one?", options: [] },
      { question: "two?", options: [] },
      { question: "three?", options: [] },
      { question: "four?", options: [] },
      { question: "five?", options: [{ label: " ", description: "" }, { label: "keep", description: "d" }] },
    ],
  });
  assert.equal(request.questions.length, 5);
  assert.deepEqual(request.questions.map(question => question.id), [
    "question-1", "question-2", "question-3", "question-4", "question-5",
  ]);
  assert.deepEqual(request.questions[4]?.options, [{ description: "d", label: "keep" }]);
});

test("single-question requests keep the compact display contract", () => {
  const single = buildWorkbenchQuestionnaireRequest({ id: "a", questions: [{ question: "go?", options: [] }] });
  assert.equal(single.title, "go?");
  assert.equal(single.summary, "");
  const multi = buildWorkbenchQuestionnaireRequest({
    id: "b",
    questions: [{ question: "one?", options: [] }, { question: "two?", options: [] }],
  });
  assert.ok(multi.summary.trim());
  assert.ok(multi.title.trim());
});

test("approval requests stay recognizable by shared approval decision routing", () => {
  const request = buildWorkbenchApprovalRequest({
    actionLabel: "command",
    details: ["detail"],
    id: "approval",
    prompt: "Run it?",
    title: "Approval",
  });
  assert.equal(request.questions[0]?.id, WORKBENCH_APPROVAL_DECISION_QUESTION_ID);
  assert.equal(request.questions[0]?.allowOther, false);
  assert.equal(hasWorkbenchApprovalDecisionSelection(request, {
    answers: { [WORKBENCH_APPROVAL_DECISION_QUESTION_ID]: { answers: [WORKBENCH_APPROVAL_DECLINE_LABEL] } },
  }), true);
});
