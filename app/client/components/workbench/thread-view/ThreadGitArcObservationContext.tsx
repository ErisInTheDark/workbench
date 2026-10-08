/*
 * Exports:
 * - ThreadGitArcObservationProvider: provide one active thread controller's proposal observations and summaries, demand action and running acceptance.
 * - useThreadGitArcProposalObservation: read and demand one proposal's source-local observation state, its observed summary and its acceptance role.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { WorkbenchGitArcLifecycleState, WorkbenchGitArcProposalSummary } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";

type ThreadGitArcAcceptance = NonNullable<WorkbenchGitArcLifecycleState["acceptance"]>;

interface ThreadGitArcObservationSource {
  acceptance: ThreadGitArcAcceptance | null;
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
  summaries: ReadonlyMap<string, WorkbenchGitArcProposalSummary>;
}

const ThreadGitArcObservationContext = createContext<ThreadGitArcObservationSource | null>(null);

export function ThreadGitArcObservationProvider({
  acceptance = null,
  children,
  lifecycleProposals,
  observeProposal,
  proposals,
}: {
  /** The observed lifecycle's running batched acceptance, if any. */
  acceptance?: ThreadGitArcAcceptance | null;
  children: ReactNode;
  /** The observed lifecycle's proposals; their Git-derived summaries need no proposal read. */
  lifecycleProposals: WorkbenchGitArcLifecycleState["proposals"] | null;
  observeProposal(proposalId: string): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}) {
  const summaries = useMemo(() => new Map((lifecycleProposals ?? []).flatMap(({ proposalId, summary }) => (
    summary ? [[proposalId, summary] as const] : []
  ))), [lifecycleProposals]);
  const source = useMemo(
    () => ({ acceptance, observeProposal, proposals, summaries }),
    [acceptance, observeProposal, proposals, summaries],
  );
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
    /** Present while the observed lifecycle owns this proposal and Git has been read. */
    summary: proposalId ? proposals?.summaries.get(proposalId) ?? null : null,
  };
}
