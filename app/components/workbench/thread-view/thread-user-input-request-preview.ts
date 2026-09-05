/*
 * Exports:
 * - formatQuestionDisplay: normalize questionnaire headers without discarding longer topic labels. Keywords: questionnaire, header, question, display.
 * - shouldUseCompactSingleQuestionDisplay: detect single-question requests that can omit repeated framing. Keywords: questionnaire, compact, single.
 * - getThreadUserInputRequestPreviewText: use the shared full title in composer previews. Keywords: questionnaire, title, preview, sticky composer.
 */

import type { WorkbenchUserInputQuestion, WorkbenchUserInputRequest } from "workbench-shared/types";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";

const GENERIC_CODEX_QUESTIONNAIRE_TITLE = "Follow-up questions";
const GENERIC_CODEX_QUESTIONNAIRE_SUMMARY = "Codex needs your input before it can continue.";

function normalizeHeaderText (value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function formatQuestionDisplay (
  question: WorkbenchUserInputQuestion,
  index: number,
) {
  const fallbackHeader = `Question ${index + 1}`;
  const rawHeader = question.header.trim();
  const normalizedHeader = normalizeHeaderText(question.header);
  const questionText = question.question.trim();
  const headerLooksLikeQuestion = !normalizedHeader
    || /[?.!]$/u.test(rawHeader);

  if (headerLooksLikeQuestion) {
    return {
      headerText: fallbackHeader,
      questionText: questionText || normalizedHeader || "No question text provided.",
    };
  }

  return {
    headerText: normalizedHeader,
    questionText,
  };
}

function isGenericCodexQuestionnaireRequest (request: WorkbenchUserInputRequest) {
  return request.title.trim() === GENERIC_CODEX_QUESTIONNAIRE_TITLE
    && request.summary.trim() === GENERIC_CODEX_QUESTIONNAIRE_SUMMARY;
}

export function shouldUseCompactSingleQuestionDisplay (request: WorkbenchUserInputRequest) {
  if (request.questions.length !== 1) {
    return false;
  }

  const questionText = request.questions[0]?.question.trim() ?? "";
  if (!questionText) {
    return false;
  }

  return isGenericCodexQuestionnaireRequest(request)
    || (!request.summary.trim() && getQuestionnaireTitle(request) === questionText);
}

export function getThreadUserInputRequestPreviewText (request: WorkbenchUserInputRequest) {
  const requestSummary = shouldUseCompactSingleQuestionDisplay(request) ? "" : request.summary.trim();
  const titleAndSummary = [getQuestionnaireTitle(request), requestSummary].filter(Boolean).join(" ");
  if (titleAndSummary) return titleAndSummary;

  const firstQuestion = request.questions[0] ?? null;
  if (!firstQuestion) return "Questionnaire";
  const { questionText, headerText } = formatQuestionDisplay(firstQuestion, 0);
  return questionText || headerText || "Questionnaire";
}
