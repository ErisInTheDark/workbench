/*
 * Exports:
 * - ThreadGitArcObservationProvider: provide one active thread controller's proposal and claim-change observations, summaries, demand actions and running acceptance.
 * - useThreadGitArcProposalObservation: read and demand one proposal's (or read variant's) source-local observation state, its observed summary and its acceptance role.
 * - useThreadGitArcClaimChanges: demand the active claim's change state while enabled, with a re-read action.
 */
"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import type { WorkbenchGitArcLifecycleState, WorkbenchGitArcProposalSummary } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadGitArcClaimObservation } from "../../../workbench/thread/ThreadGitArcClaimObserver";
import {
  getThreadGitArcProposalObservationKey,
  type ThreadGitArcProposalObservation,
  type ThreadGitArcProposalVariant,
} from "../../../workbench/thread/ThreadGitArcProposalObserver";

type ThreadGitArcAcceptance = NonNullable<WorkbenchGitArcLifecycleState["acceptance"]>;

interface ThreadGitArcObservationSource {
  acceptance: ThreadGitArcAcceptance | null;
  claimChanges: ThreadGitArcClaimObservation | null;
  observeClaimChanges(): () => void;
  observeProposal(proposalId: string, variant?: ThreadGitArcProposalVariant): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
  refreshClaimChanges(): void;
  summaries: ReadonlyMap<string, WorkbenchGitArcProposalSummary>;
}

const ThreadGitArcObservationContext = createContext<ThreadGitArcObservationSource | null>(null);
const NO_DEMAND = () => () => {};
const NO_REFRESH = () => {};

export function ThreadGitArcObservationProvider({
  acceptance = null,
  children,
  claimChanges = null,
  lifecycleProposals,
  observeClaimChanges = NO_DEMAND,
  observeProposal,
  proposals,
  refreshClaimChanges = NO_REFRESH,
}: {
  /** The observed lifecycle's running batched acceptance, if any. */
  acceptance?: ThreadGitArcAcceptance | null;
  children: ReactNode;
  /** Absent for hosts that observe no claim, whose claim state stays unknown. */
  claimChanges?: ThreadGitArcClaimObservation | null;
  /** The observed lifecycle's proposals; their Git-derived summaries need no proposal read. */
  lifecycleProposals: WorkbenchGitArcLifecycleState["proposals"] | null;
  observeClaimChanges?: () => () => void;
  observeProposal(proposalId: string, variant?: ThreadGitArcProposalVariant): () => void;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
  refreshClaimChanges?: () => void;
}) {
  const summaries = useMemo(() => new Map((lifecycleProposals ?? []).flatMap(({ proposalId, summary }) => (
    summary ? [[proposalId, summary] as const] : []
  ))), [lifecycleProposals]);
  const source = useMemo(
    () => ({ acceptance, claimChanges, observeClaimChanges, observeProposal, proposals, refreshClaimChanges, summaries }),
    [acceptance, claimChanges, observeClaimChanges, observeProposal, proposals, refreshClaimChanges, summaries],
  );
  return (
    <ThreadGitArcObservationContext.Provider value={source}>
      {children}
    </ThreadGitArcObservationContext.Provider>
  );
}

export function useThreadGitArcProposalObservation(proposalId: string | null, variant: ThreadGitArcProposalVariant = {}) {
  const proposals = useContext(ThreadGitArcObservationContext);
  const acceptance = proposals?.acceptance ?? null;
  return {
    /** "landing" while this proposal commits inside a batched acceptance, "queued" while it waits there. */
    acceptance: !proposalId || !acceptance ? null
      : acceptance.landingId === proposalId ? "landing" as const
        : acceptance.queuedIds.includes(proposalId) ? "queued" as const : null,
    isObserved: proposals !== null,
    observe: proposals?.observeProposal ?? null,
    state: proposalId ? proposals?.proposals[getThreadGitArcProposalObservationKey(proposalId, variant)] ?? null : null,
    /** Present while the observed lifecycle owns this proposal and Git has been read. */
    summary: proposalId ? proposals?.summaries.get(proposalId) ?? null : null,
  };
}

/** Null without an observing thread, where no claim state can be known. */
export function useThreadGitArcClaimChanges(enabled: boolean) {
  const source = useContext(ThreadGitArcObservationContext);
  const observe = source?.observeClaimChanges ?? null;
  useEffect(() => {
    if (!enabled || !observe) return;
    return observe();
  }, [enabled, observe]);
  return source ? { refresh: source.refreshClaimChanges, state: enabled ? source.claimChanges : null } : null;
}
