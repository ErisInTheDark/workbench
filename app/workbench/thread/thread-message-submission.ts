/*
 * Exports:
 * - ThreadMessageNotSentError: expected pre-dispatch cancellation that silently restores composer input. Keywords: message, draft, cancellation.
 * - isThreadMessageNotSentError: classify expected not-sent cancellation without matching text. Keywords: message, error, classification.
 * - runThreadComposerSubmission: commit or restore one composer submission around provider admission. Keywords: composer, draft, admission.
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
  clearDurableDraft: () => void;
  preserveDurableDraft: () => void;
  restoreLocalInput: () => void;
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
  preserveDurableDraft();
  try {
    await send();
    clearDurableDraft();
    return true;
  } catch (error) {
    restoreLocalInput();
    if (!isThreadMessageNotSentError(error)) {
      showError(error instanceof Error ? error.message : "Unable to send that message.");
    }
    return false;
  }
}
