/*
 * Exports:
 * - ThreadCheckpointCommitAction: one mounted proposal controller's readiness, batched commit choices and outcome handling.
 * - ThreadCheckpointCommitOutcome: a batched acceptance's landed proposal or failure for one proposal.
 * - ThreadCheckpointStoredProposal: observed proposal commit facts used while a card has not loaded.
 * - ThreadCheckpointCommitActionsContext: provide the owning lifecycle list's registry to its proposal controllers.
 * - default ThreadCheckpointCommitActions: resolve each proposal's commit action (loaded card first, observed summary otherwise) and land selected proposals in one batched acceptance.
 */
"use client";

import { createContext } from "react";

import type {
  GitArcProposalCommitEntry,
  GitArcProposalCommitManyResult,
  GitCheckpointProposal,
} from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcFailureException } from "workbench-shared/workbench/git/git-arc-failures";

export type ThreadCheckpointCommitOutcome = { proposal: GitCheckpointProposal } | { error: unknown };

export interface ThreadCheckpointCommitAction {
  /** This proposal's current commit choices, or null when it has nothing committable. */
  entry: () => GitArcProposalCommitEntry | null;
  /** False until the card loaded its proposal; an unloaded card defers to the observed summary. Defaults to true. */
  loaded?: boolean;
  ready: boolean;
  /** Shows a batched acceptance's outcome for this proposal on its own card. */
  settle: (outcome: ThreadCheckpointCommitOutcome) => void;
}

export interface ThreadCheckpointStoredProposal {
  description: string;
  /** False only when recorded totals prove the proposal empty; unknown totals defer to the daemon's revalidation. */
  hasChanges: boolean;
  mode: "amend" | "commit";
  proposalId: string;
  status: "committed" | "proposed";
  title: string;
}

function isStoredReady(proposal: ThreadCheckpointStoredProposal) {
  return proposal.status === "proposed" && proposal.hasChanges && Boolean(proposal.title.trim());
}

export default class ThreadCheckpointCommitActions {
  readonly #actions = new Map<string, ThreadCheckpointCommitAction>();
  readonly #listeners = new Set<() => void>();
  #stored = new Map<string, ThreadCheckpointStoredProposal>();
  #settleStored: ((proposal: ThreadCheckpointStoredProposal, outcome: ThreadCheckpointCommitOutcome) => void) | null = null;

  register(proposalId: string, action: ThreadCheckpointCommitAction) {
    this.#actions.set(proposalId, action);
    this.#notify();
    return () => {
      if (this.#actions.get(proposalId) !== action) return;
      this.#actions.delete(proposalId);
      this.#notify();
    };
  }

  /** Replace the observed summaries; they commit with their stored message, so cards that never loaded still take part. */
  setStored(
    proposals: readonly ThreadCheckpointStoredProposal[],
    settle: (proposal: ThreadCheckpointStoredProposal, outcome: ThreadCheckpointCommitOutcome) => void,
  ) {
    this.#stored = new Map(proposals.map(proposal => [proposal.proposalId, proposal]));
    this.#settleStored = settle;
    this.#notify();
    return () => {
      if (this.#settleStored !== settle) return;
      this.#stored = new Map();
      this.#settleStored = null;
      this.#notify();
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #resolve(proposalId: string, storedTier = { stored: this.#stored, settleStored: this.#settleStored }): ThreadCheckpointCommitAction | null {
    const card = this.#actions.get(proposalId);
    if (card && card.loaded !== false) return card;
    const stored = storedTier.stored.get(proposalId);
    const settleStored = storedTier.settleStored;
    if (stored && settleStored) {
      return {
        entry: () => ({ description: stored.description, includeNewer: false, mode: stored.mode, proposalId, title: stored.title }),
        ready: isStoredReady(stored),
        settle: outcome => settleStored(stored, outcome),
      };
    }
    return card ?? null;
  }

  isReady(proposalIds: readonly string[]) {
    return proposalIds.length > 0 && proposalIds.every(proposalId => this.#resolve(proposalId)?.ready);
  }

  /**
   * Lands every proposal in one batched acceptance, in order; the daemon stops at the first failure and earlier ones
   * stay landed. Readiness gates the start only, since the daemon revalidates each proposal. Proposals with neither a
   * card nor a summary stop the run before it starts. The stored tier is captured at the start, because each landed
   * commit changes the observed summaries.
   */
  async commitAll(
    proposalIds: readonly string[],
    commitMany: (entries: GitArcProposalCommitEntry[]) => Promise<GitArcProposalCommitManyResult>,
  ) {
    if (!this.isReady(proposalIds)) return false;
    const storedTier = { stored: this.#stored, settleStored: this.#settleStored };
    const actions = proposalIds.map(proposalId => this.#resolve(proposalId, storedTier));
    const entries = actions.map(action => action?.entry() ?? null);
    if (entries.some(entry => !entry)) return false;
    const byProposal = new Map(proposalIds.map((proposalId, index) => [proposalId, actions[index]!]));
    let result: GitArcProposalCommitManyResult;
    try {
      result = await commitMany(entries as GitArcProposalCommitEntry[]);
    } catch (error) {
      // Nothing was accepted; the first proposal reports why.
      actions[0]!.settle({ error });
      return false;
    }
    for (const proposal of result.landed) byProposal.get(proposal.proposalId)?.settle({ proposal });
    if (!result.failed) return true;
    byProposal.get(result.failed.proposalId)?.settle({ error: new GitArcFailureException(result.failed.failure) });
    return false;
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }
}

export const ThreadCheckpointCommitActionsContext = createContext<ThreadCheckpointCommitActions | null>(null);
