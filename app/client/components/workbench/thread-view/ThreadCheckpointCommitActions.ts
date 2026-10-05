/*
 * Exports:
 * - ThreadCheckpointCommitAction: one mounted proposal controller's readiness and commit entry point.
 * - ThreadCheckpointStoredProposal: bulk-read proposal commit facts used while a card has not loaded.
 * - ThreadCheckpointCommitActionsContext: provide the owning view's registry to relocatable proposal controllers.
 * - default ThreadCheckpointCommitActions: resolve each proposal's commit action (loaded card first, bulk summary otherwise) and commit selected proposals in order.
 */
"use client";

import { createContext } from "react";

import type { GitArcProposalSummary } from "workbench-shared/workbench/git/checkpoint-contracts";

export interface ThreadCheckpointCommitAction {
  /** Resolves false when the controller surfaced a failure on its own card. */
  commit: () => Promise<boolean>;
  /** False until the card loaded its proposal; an unloaded card defers to the bulk summary. Defaults to true. */
  loaded?: boolean;
  ready: boolean;
}

export type ThreadCheckpointStoredProposal = Omit<GitArcProposalSummary, "rootId">;

function isStoredReady(proposal: ThreadCheckpointStoredProposal) {
  return proposal.status === "proposed" && proposal.hasChanges && Boolean(proposal.title.trim());
}

export default class ThreadCheckpointCommitActions {
  readonly #actions = new Map<string, ThreadCheckpointCommitAction>();
  readonly #listeners = new Set<() => void>();
  #stored = new Map<string, ThreadCheckpointStoredProposal>();
  #commitStored: ((proposal: ThreadCheckpointStoredProposal) => Promise<boolean>) | null = null;

  register(proposalId: string, action: ThreadCheckpointCommitAction) {
    this.#actions.set(proposalId, action);
    this.#notify();
    return () => {
      if (this.#actions.get(proposalId) !== action) return;
      this.#actions.delete(proposalId);
      this.#notify();
    };
  }

  /** Replace the bulk summaries; their commits use the stored message, so cards that never loaded still take part. */
  setStored(proposals: readonly ThreadCheckpointStoredProposal[], commit: (proposal: ThreadCheckpointStoredProposal) => Promise<boolean>) {
    this.#stored = new Map(proposals.map(proposal => [proposal.proposalId, proposal]));
    this.#commitStored = commit;
    this.#notify();
    return () => {
      if (this.#commitStored !== commit) return;
      this.#stored = new Map();
      this.#commitStored = null;
      this.#notify();
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #resolve(proposalId: string): ThreadCheckpointCommitAction | null {
    const card = this.#actions.get(proposalId);
    if (card && card.loaded !== false) return card;
    const stored = this.#stored.get(proposalId);
    const commitStored = this.#commitStored;
    if (stored && commitStored) return { commit: () => commitStored(stored), ready: isStoredReady(stored) };
    return card ?? null;
  }

  isReady(proposalIds: readonly string[]) {
    return proposalIds.length > 0 && proposalIds.every(proposalId => this.#resolve(proposalId)?.ready);
  }

  /**
   * Commits sequentially because each commit moves HEAD before the next proposal revalidates.
   * Readiness gates the start only: later cards briefly rehydrate after HEAD moves, and the
   * commit endpoint revalidates each proposal anyway. Proposals with neither a card nor a summary stop the run.
   */
  async commitAll(proposalIds: readonly string[]) {
    if (!this.isReady(proposalIds)) return false;
    for (const proposalId of proposalIds) {
      const action = this.#resolve(proposalId);
      if (!action || !await action.commit()) return false;
    }
    return true;
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

export const ThreadCheckpointCommitActionsContext = createContext<ThreadCheckpointCommitActions | null>(null);
