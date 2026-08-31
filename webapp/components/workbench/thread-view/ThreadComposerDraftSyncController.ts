/*
 * Default export:
 * - ThreadComposerDraftSyncController: own durable draft acknowledgement and local edit generations across hydration, saves, and thread switches. Keywords: composer, draft, hydration, lifecycle.
 */
interface ThreadComposerDraftSave {
  generation: number;
  threadId: string;
}

export default class ThreadComposerDraftSyncController {
  #acknowledgedDraftKey: string;
  #currentThreadId: string;
  #localEditGeneration = 0;
  #savedGeneration = 0;

  constructor(threadId: string, draftKey: string) {
    this.#currentThreadId = threadId;
    this.#acknowledgedDraftKey = draftKey;
  }

  acceptHydration(threadId: string, draftKey: string) {
    if (threadId !== this.#currentThreadId) {
      this.#currentThreadId = threadId;
      this.#acknowledgedDraftKey = draftKey;
      this.#localEditGeneration = 0;
      this.#savedGeneration = 0;
      return true;
    }
    if (draftKey === this.#acknowledgedDraftKey) return false;
    this.#acknowledgedDraftKey = draftKey;
    return this.#localEditGeneration === this.#savedGeneration;
  }

  noteEdit() {
    this.#localEditGeneration += 1;
  }

  beginSave(): ThreadComposerDraftSave | null {
    if (this.#localEditGeneration === this.#savedGeneration) return null;
    return {
      generation: this.#localEditGeneration,
      threadId: this.#currentThreadId,
    };
  }

  completeSave(save: ThreadComposerDraftSave) {
    if (save.threadId !== this.#currentThreadId) return;
    this.#savedGeneration = Math.max(this.#savedGeneration, save.generation);
  }

  completeSubmission(threadId: string) {
    if (threadId !== this.#currentThreadId) return;
    this.#savedGeneration = this.#localEditGeneration;
  }
}
