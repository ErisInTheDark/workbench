/*
 * Exports:
 * - formatQuestionDisplay: normalize questionnaire headers and question text for rendering. Keywords: questionnaire, header, question, display.
 * - shouldUseCompactSingleQuestionDisplay: detect generic single-question requests that can omit repeated framing. Keywords: questionnaire, compact, single.
 * - getThreadUserInputRequestPreviewText: derive compact questionnaire text for composer previews. Keywords: questionnaire, preview, sticky composer.
 */

import type { WorkbenchUserInputQuestion, WorkbenchUserInputRequest } from "../../../lib/types";

const MAX_HEADER_LENGTH = 36;
const MAX_HEADER_WORDS = 5;
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
    || normalizedHeader.length > MAX_HEADER_LENGTH
    || normalizedHeader.split(/\s+/).filter(Boolean).length > MAX_HEADER_WORDS
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
    || (!request.summary.trim() && request.title.trim() === questionText);
}

export function getThreadUserInputRequestPreviewText (request: WorkbenchUserInputRequest) {
  const compactQuestion = shouldUseCompactSingleQuestionDisplay(request)
    ? request.questions[0] ?? null
    : null;
  const requestTitle = compactQuestion?.question.trim() || request.title.trim();
  const requestSummary = compactQuestion ? "" : request.summary.trim();
  const titleAndSummary = [requestTitle, requestSummary].filter(Boolean).join(" ");

  if (titleAndSummary) {
    return titleAndSummary;
  }

  const firstQuestion = request.questions[0] ?? null;
  if (!firstQuestion) {
    return "Questionnaire";
  }

  const { questionText, headerText } = formatQuestionDisplay(firstQuestion, 0);
  return questionText.trim() || headerText.trim() || "Questionnaire";
}
