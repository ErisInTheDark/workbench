/*
 * Exports:
 * - WORKBENCH_APPROVAL_DECISION_QUESTION_ID: stable approval decision question id. Keywords: questionnaire, approval, decision.
 * - isWorkbenchApprovalDecisionQuestion: detect Workbench approval option questions. Keywords: questionnaire, approval, options.
 * - isWorkbenchApprovalRequest: detect fixed-option Workbench approval requests. Keywords: questionnaire, approval, guard.
 * - hasWorkbenchApprovalDecisionSelection: confirm an approval response chose an approval option. Keywords: questionnaire, approval, validation.
 * - getWorkbenchApprovalSupplementalSteerText: extract custom approval text that should be sent as steer. Keywords: questionnaire, approval, custom text, steer.
 */

import type {
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../types";

export const WORKBENCH_APPROVAL_DECISION_QUESTION_ID = "decision";

const WORKBENCH_APPROVAL_OPTION_LABELS = new Set(["Allow once", "Allow for session", "Decline"]);

function isWorkbenchApprovalOptionLabel(value: string) {
  return WORKBENCH_APPROVAL_OPTION_LABELS.has(value);
}

function getAnswerValues(
  response: WorkbenchUserInputResponse,
  questionId: string,
) {
  return response.answers[questionId]?.answers ?? [];
}

function getCustomAnswerValues(
  question: WorkbenchUserInputQuestion,
  response: WorkbenchUserInputResponse,
) {
  const optionLabels = new Set(question.options.map((option) => option.label));
  return getAnswerValues(response, question.id)
    .map((answer) => answer.trim())
    .filter((answer) => answer && !optionLabels.has(answer));
}

export function isWorkbenchApprovalDecisionQuestion(question: WorkbenchUserInputQuestion) {
  return question.id === WORKBENCH_APPROVAL_DECISION_QUESTION_ID
    && question.options.some((option) => isWorkbenchApprovalOptionLabel(option.label));
}

export function isWorkbenchApprovalRequest(request: WorkbenchUserInputRequest) {
  return request.questions.some(isWorkbenchApprovalDecisionQuestion);
}

export function hasWorkbenchApprovalDecisionSelection(
  request: WorkbenchUserInputRequest,
  response: WorkbenchUserInputResponse,
) {
  return request.questions
    .filter(isWorkbenchApprovalDecisionQuestion)
    .some((question) => getAnswerValues(response, question.id).some(isWorkbenchApprovalOptionLabel));
}

export function getWorkbenchApprovalSupplementalSteerText(
  request: WorkbenchUserInputRequest,
  response: WorkbenchUserInputResponse,
) {
  if (!isWorkbenchApprovalRequest(request)) {
    return null;
  }

  const customAnswers = request.questions.flatMap((question) => getCustomAnswerValues(question, response));
  return customAnswers.length ? customAnswers.join("\n\n") : null;
}
