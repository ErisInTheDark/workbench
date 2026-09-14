/*
 * Exports:
 * - ThreadGitArcObservationProvider: provide one active thread controller's proposal observations and demand action.
 * - useThreadGitArcProposalObservation: read and demand one proposal's source-local observation state.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";

interface ThreadGitArcObservationSource {
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}

const ThreadGitArcObservationContext = createContext<ThreadGitArcObservationSource | null>(null);

export function ThreadGitArcObservationProvider({
  children,
  observeProposal,
  proposals,
}: {
  children: ReactNode;
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}) {
  const source = useMemo(() => ({ observeProposal, proposals }), [observeProposal, proposals]);
  return (
    <ThreadGitArcObservationContext.Provider value={source}>
      {children}
    </ThreadGitArcObservationContext.Provider>
  );
}

export function useThreadGitArcProposalObservation(proposalId: string | null) {
  const proposals = useContext(ThreadGitArcObservationContext);
  return {
    isObserved: proposals !== null,
    observe: proposals?.observeProposal ?? null,
    state: proposalId ? proposals?.proposals[proposalId] ?? null : null,
  };
}
