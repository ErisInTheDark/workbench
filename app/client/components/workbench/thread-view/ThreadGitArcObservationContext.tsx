/*
 * Exports:
 * - ThreadGitArcObservationProvider: provide one active thread controller's proposal observations, demand action and running acceptance.
 * - useThreadGitArcProposalObservation: read and demand one proposal's source-local observation state and its acceptance role.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { WorkbenchGitArcLifecycleState } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";

type ThreadGitArcAcceptance = NonNullable<WorkbenchGitArcLifecycleState["acceptance"]>;

interface ThreadGitArcObservationSource {
  acceptance: ThreadGitArcAcceptance | null;
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}

const ThreadGitArcObservationContext = createContext<ThreadGitArcObservationSource | null>(null);

export function ThreadGitArcObservationProvider({
  acceptance = null,
  children,
  observeProposal,
  proposals,
}: {
  /** The observed lifecycle's running batched acceptance, if any. */
  acceptance?: ThreadGitArcAcceptance | null;
  children: ReactNode;
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}) {
  const source = useMemo(() => ({ acceptance, observeProposal, proposals }), [acceptance, observeProposal, proposals]);
  return (
    <ThreadGitArcObservationContext.Provider value={source}>
      {children}
    </ThreadGitArcObservationContext.Provider>
  );
}

export function useThreadGitArcProposalObservation(proposalId: string | null) {
  const proposals = useContext(ThreadGitArcObservationContext);
  const acceptance = proposals?.acceptance ?? null;
  return {
    /** "landing" while this proposal commits inside a batched acceptance, "queued" while it waits there. */
    acceptance: !proposalId || !acceptance ? null
      : acceptance.landingId === proposalId ? "landing" as const
        : acceptance.queuedIds.includes(proposalId) ? "queued" as const : null,
    isObserved: proposals !== null,
    observe: proposals?.observeProposal ?? null,
    state: proposalId ? proposals?.proposals[proposalId] ?? null : null,
  };
}
