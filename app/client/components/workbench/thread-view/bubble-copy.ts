/*
 * Exports:
 * - BubbleCopyFeedbackNode: accessible bubble copy surface.
 * - BubbleCopyFeedbackController: disposable bubble copy feedback.
 * - createBubbleCopyFeedbackController: configure shared feedback for message controls.
 * - bubbleCopyFeedbackController: shared production message copy controller.
 * - getUserMessageCopyMarkdown: preserve ordered user text, excluding attachments.
 */

import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { createCopyFeedbackController } from "../../../workbench/dom/clipboard-copy-feedback";
export type { CopyFeedbackNode as BubbleCopyFeedbackNode, CopyFeedbackController as BubbleCopyFeedbackController } from "../../../workbench/dom/clipboard-copy-feedback";

export function getUserMessageCopyMarkdown(input: readonly UserInput[]) {
  return input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .filter((markdown) => Boolean(markdown.trim()))
    .join("\n\n");
}

export function createBubbleCopyFeedbackController(options: Parameters<typeof createCopyFeedbackController>[0] = {}) {
  return createCopyFeedbackController({
    ...options, attribute: "data-thread-bubble-copy-state", label: "Copy message", copiedLabel: "Copied message",
  });
}

export const bubbleCopyFeedbackController = createBubbleCopyFeedbackController();
