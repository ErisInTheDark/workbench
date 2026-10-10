/*
 * Keywords: composer, draft, preservation, admission, cleanup, cancellation.
 * Exports:
 * - ThreadMessageNotSentError: expected pre-dispatch cancellation that silently restores composer input. Keywords: message, draft, cancellation.
 * - isThreadMessageNotSentError: classify expected not-sent cancellation without matching text. Keywords: message, error, classification.
 * - createThreadComposerMessageInput: build existing-thread text and image input from one composer draft.
 * - runThreadComposerSubmission: await preservation and admission, then report cleanup without inviting a duplicate send.
 */

import type { WorkbenchThreadComposerAttachmentDraft } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  createComposerReferenceMessage,
  type ComposerReference,
} from "workbench-shared/workbench/thread/composer-reference";

export function createThreadComposerMessageInput(
  message: string,
  attachments: readonly WorkbenchThreadComposerAttachmentDraft[],
  references: readonly ComposerReference[],
): UserInput[] {
  const input: UserInput[] = [];
  const text = createComposerReferenceMessage(references, message);
  if (text) input.push({ type: "text", text, text_elements: [] });
  for (const attachment of attachments) input.push({ type: "image", url: attachment.url });
  return input;
}

export class ThreadMessageNotSentError extends Error {
  constructor() {
    super("The message was not sent.");
    this.name = "ThreadMessageNotSentError";
  }
}

export function isThreadMessageNotSentError(error: unknown): error is ThreadMessageNotSentError {
  return error instanceof ThreadMessageNotSentError;
}

interface RunThreadComposerSubmissionOptions {
  clearDurableDraft: () => Promise<void> | void;
  preserveDurableDraft: () => Promise<void> | void;
  restoreLocalInput?: () => void;
  send: () => Promise<void>;
  showError: (message: string) => void;
}

export async function runThreadComposerSubmission({
  clearDurableDraft,
  preserveDurableDraft,
  restoreLocalInput,
  send,
  showError,
}: RunThreadComposerSubmissionOptions) {
  try {
    await preserveDurableDraft();
    await send();
  } catch (error) {
    restoreLocalInput?.();
    if (!isThreadMessageNotSentError(error)) {
      showError(error instanceof Error ? error.message : "Unable to send that message.");
    }
    return false;
  }
  try {
    await clearDurableDraft();
  } catch (error) {
    showError(error instanceof Error ? error.message : "The message was sent, but its draft could not be cleared.");
  }
  return true;
}
