/*
 * Exports:
 * - renderUserInputMarkdown: convert UserInput records into reorientation-safe Markdown with image placeholders. Keywords: user input, image placeholder, markdown.
 * - renderWorkbenchThreadContextPieceMarkdown: render one heading-free chronological context piece. Keywords: thread context, piece, markdown.
 * - getWorkbenchThreadContextPieceRef: derive one stable stateless ref for a projected context piece. Keywords: thread context, ref.
 */

import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import {
  getQuestionnairePromptText,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import { readWorkbenchAgentMessageInput } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchThreadContextPiece } from "./thread-context-projection.ts";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";

const IMAGE_PLACEHOLDER = "<an image was sent>";

function normalizeMarkdownPart(value: string) {
  return value.trim();
}

export function renderUserInputMarkdown(input: readonly UserInput[]) {
  const parts = unwrapWorkbenchSteerDisplayInput(input).map((item) => {
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
    return `**Q: ${prompt}**\n\nA: ${answers}`;
  }).filter(Boolean);

  return parts.join("\n\n");
}

export function renderWorkbenchThreadContextPieceMarkdown(piece: WorkbenchThreadContextPiece) {
  if (piece.kind === "userMessage" || piece.kind === "userSteer") {
    const agentMessage = readWorkbenchAgentMessageInput(piece.input);
    if (agentMessage) {
      return `Agent message from ${agentMessage.senderName} (${agentMessage.senderThreadId})\n\n${agentMessage.message}`;
    }
  }
  switch (piece.kind) {
    case "userMessage":
      return renderUserInputMarkdown(piece.displayInput);
    case "userSteer":
      return renderUserInputMarkdown(piece.displayInput);
    case "questionnaire":
      return renderQuestionnaireMarkdown(piece);
    case "planBlock":
      return piece.planMarkdown;
  }
}

export function getWorkbenchThreadContextPieceRef(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return `user:${piece.itemId}`;
    case "userSteer":
      return `steer:${piece.turnId}:${piece.entry.entryKey}`;
    case "questionnaire":
      return `questionnaire:${piece.turnId}:${piece.entry.requestKey}`;
    case "planBlock":
      return `plan-block:${piece.itemId}:${piece.blockIndex}`;
  }
}
