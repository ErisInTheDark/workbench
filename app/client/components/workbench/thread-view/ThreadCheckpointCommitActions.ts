/*
 * Exports:
 * - ThreadCheckpointCommitAction: one mounted proposal controller's readiness and commit entry point.
 * - ThreadCheckpointCommitActionsContext: provide the owning view's registry to relocatable proposal controllers.
 * - default ThreadCheckpointCommitActions: register proposal commit actions and commit selected proposals in order.
 */
"use client";

import { createContext } from "react";

export interface ThreadCheckpointCommitAction {
  /** Resolves false when the controller surfaced a failure on its own card. */
  commit: () => Promise<boolean>;
  ready: boolean;
}

export default class ThreadCheckpointCommitActions {
  readonly #actions = new Map<string, ThreadCheckpointCommitAction>();
  readonly #listeners = new Set<() => void>();

  register(proposalId: string, action: ThreadCheckpointCommitAction) {
    this.#actions.set(proposalId, action);
    this.#notify();
    return () => {
      if (this.#actions.get(proposalId) !== action) return;
      this.#actions.delete(proposalId);
      this.#notify();
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  isReady(proposalIds: readonly string[]) {
    return proposalIds.length > 0 && proposalIds.every(proposalId => this.#actions.get(proposalId)?.ready);
  }

  /**
   * Commits sequentially because each commit moves HEAD before the next proposal revalidates.
   * Readiness gates the start only: later cards briefly rehydrate after HEAD moves, and the
   * commit endpoint revalidates each proposal anyway. Unmounted cards stop the run.
   */
  async commitAll(proposalIds: readonly string[]) {
    if (!this.isReady(proposalIds)) return false;
    for (const proposalId of proposalIds) {
      const action = this.#actions.get(proposalId);
      if (!action || !await action.commit()) return false;
    }
    return true;
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

export const ThreadCheckpointCommitActionsContext = createContext<ThreadCheckpointCommitActions | null>(null);
