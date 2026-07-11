/*
 * Exports:
 * - renderUserInputMarkdown: convert UserInput records into reorientation-safe Markdown with image placeholders. Keywords: user input, image placeholder, markdown.
 * - renderWorkbenchThreadContextMarkdown: render ordered thread context pieces as stitched Markdown. Keywords: thread context, reorientation, markdown.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import {
  getQuestionnairePromptText,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "./thread-questionnaire-transcript";
import type { WorkbenchThreadContextPiece } from "./thread-context-projection";

const IMAGE_PLACEHOLDER = "<an image was sent>";
const THREAD_CONTEXT_HISTORY_HEADER = `
# Thread Context History

Chronological evidence for reorientation. Older entries may be completed, rejected, or superseded; they are not automatically the current task.
`.trim();

function normalizeMarkdownPart(value: string) {
  return value.trim();
}

export function renderUserInputMarkdown(input: readonly UserInput[]) {
  const parts = input.map((item) => {
    switch (item.type) {
      case "text":
        return normalizeMarkdownPart(item.text) || "";
      case "image":
      case "localImage":
        return IMAGE_PLACEHOLDER;
      case "skill":
        return `Skill: ${item.name} (${item.path})`;
      case "mention":
        return `Mention: ${item.name} (${item.path})`;
    }
  }).filter(Boolean);

  return parts.length ? parts.join("\n\n") : "No user content captured.";
}

function renderQuestionnaireMarkdown(piece: Extract<WorkbenchThreadContextPiece, { kind: "questionnaire" }>) {
  const parts = piece.entry.request.questions.map((question, index) => {
    const answerLabels = piece.entry.response.answers[question.id]?.answers
      .map((answer) => answer.trim())
      .filter(Boolean) ?? [];
    if (!answerLabels.length) {
      return "";
    }

    const optionDescriptionsByLabel = new Map(question.options.map((option) => [option.label, option.description.trim()]));
    const prompt = getQuestionnairePromptText(piece.entry.request, question, index)
      || (piece.entry.request.questions.length === 1
        ? question.question.trim() || getSingleQuestionnaireSummaryLabel(piece.entry.request)
        : getQuestionnaireTopicLabel(question, index))
      || `Question ${index + 1}`;
    const answers = answerLabels.map((answer) => {
      const description = optionDescriptionsByLabel.get(answer);
      const answerLabel = `**${answer}**`;
      return description ? `${answerLabel} — ${description}` : answerLabel;
    }).join("; ");
    return `## Q: ${prompt}\nA: ${answers}`;
  }).filter(Boolean);

  return parts.join("\n\n");
}

function renderContextPieceMarkdown(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return `## User Message\n\n${renderUserInputMarkdown(piece.input)}`;
    case "userSteer":
      return `## User Steer\n\n${renderUserInputMarkdown(piece.input)}`;
    case "questionnaire":
      return renderQuestionnaireMarkdown(piece);
    case "planBlock":
      return piece.planMarkdown;
  }
}

export function renderWorkbenchThreadContextMarkdown(pieces: readonly WorkbenchThreadContextPiece[]) {
  const evidenceMarkdown = pieces
    .map(renderContextPieceMarkdown)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

  return evidenceMarkdown
    ? `${THREAD_CONTEXT_HISTORY_HEADER}\n\n${evidenceMarkdown}`
    : THREAD_CONTEXT_HISTORY_HEADER;
}
