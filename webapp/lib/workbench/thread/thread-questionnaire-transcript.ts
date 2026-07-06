/*
 * Exports:
 * - getSingleQuestionnaireSummaryLabel/getQuestionnaireTopicLabel: derive compact readable labels for questionnaire requests. Keywords: questionnaire, summary, label.
 * - getQuestionnairePromptText/getQuestionnaireAnswerMarkdown: convert questionnaire prompts and answers into readable Markdown text. Keywords: questionnaire, answer, markdown.
 * - buildQuestionnaireTranscriptPairs: create prompt/answer transcript pairs for client rendering and context reorientation. Keywords: questionnaire, transcript, projection.
 */

import type {
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../types";

const GENERIC_CODEX_QUESTIONNAIRE_TITLE = "Follow-up questions";
const GENERIC_CODEX_QUESTIONNAIRE_SUMMARY = "Codex needs your input before it can continue.";

export function normalizeQuestionnaireSummaryLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateQuestionnaireSummaryLabel(value: string) {
  const normalizedValue = normalizeQuestionnaireSummaryLabel(value);
  return normalizedValue.length > 80 ? `${normalizedValue.slice(0, 77).trimEnd()}...` : normalizedValue;
}

function isGenericCodexQuestionnaireRequest(request: WorkbenchUserInputRequest) {
  return request.title.trim() === GENERIC_CODEX_QUESTIONNAIRE_TITLE
    && request.summary.trim() === GENERIC_CODEX_QUESTIONNAIRE_SUMMARY;
}

export function getSingleQuestionnaireSummaryLabel(request: WorkbenchUserInputRequest) {
  const questionText = request.questions[0]?.question.trim() ?? "";
  const title = request.title.trim();

  if (questionText && (isGenericCodexQuestionnaireRequest(request) || !title || title === GENERIC_CODEX_QUESTIONNAIRE_TITLE)) {
    return truncateQuestionnaireSummaryLabel(questionText);
  }

  return truncateQuestionnaireSummaryLabel(title || questionText || "User input request");
}

export function getQuestionnaireTopicLabel(question: WorkbenchUserInputQuestion, index: number) {
  const header = normalizeQuestionnaireSummaryLabel(question.header).replace(/[?.!:]+$/u, "");
  if (header) {
    return header.toLowerCase();
  }

  return truncateQuestionnaireSummaryLabel(question.question || `question ${index + 1}`).toLowerCase();
}

export function getQuestionnairePromptText(request: WorkbenchUserInputRequest, question: WorkbenchUserInputQuestion, index: number) {
  const questionText = question.question.trim();
  if (request.questions.length === 1) {
    const singleSummaryLabel = getSingleQuestionnaireSummaryLabel(request);
    if (questionText && singleSummaryLabel === truncateQuestionnaireSummaryLabel(questionText)) {
      return "";
    }
  }

  return questionText
    || normalizeQuestionnaireSummaryLabel(question.header)
    || `Question ${index + 1}`;
}

export function getQuestionnaireAnswerMarkdown(question: WorkbenchUserInputQuestion, response: WorkbenchUserInputResponse) {
  const answers = response.answers[question.id]?.answers
    .map((answer) => answer.trim())
    .filter(Boolean) ?? [];
  if (!answers.length) {
    return "";
  }

  const optionDescriptionsByLabel = new Map(question.options.map((option) => [option.label, option.description.trim()]));
  return answers.map((answer) => {
    const description = optionDescriptionsByLabel.get(answer);
    if (typeof description === "string") {
      return description ? `### ${answer}\n\n${description}` : answer;
    }

    return answer;
  }).join("\n\n");
}

export function buildQuestionnaireTranscriptPairs(request: WorkbenchUserInputRequest, response: WorkbenchUserInputResponse | null) {
  if (!response) {
    return [];
  }

  return request.questions.map((question, index) => {
    const answerMarkdown = getQuestionnaireAnswerMarkdown(question, response);
    if (!answerMarkdown) {
      return null;
    }

    return {
      answerMarkdown,
      promptText: getQuestionnairePromptText(request, question, index),
    };
  }).filter((pair): pair is { answerMarkdown: string; promptText: string } => pair !== null);
}
