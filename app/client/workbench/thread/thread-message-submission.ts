/*
 * Keywords: composer, draft, preservation, admission, cleanup, cancellation.
 * Exports:
 * - ThreadMessageNotSentError: expected pre-dispatch cancellation that silently restores composer input. Keywords: message, draft, cancellation.
 * - isThreadMessageNotSentError: classify expected not-sent cancellation without matching text. Keywords: message, error, classification.
 * - runThreadComposerSubmission: await preservation and admission, then report cleanup without inviting a duplicate send.
 */

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
