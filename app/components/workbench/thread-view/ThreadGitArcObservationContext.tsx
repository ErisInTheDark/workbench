/*
 * Exports:
 * - ThreadGitArcObservationProvider: provide one active thread controller's proposal observations.
 * - useThreadGitArcProposalObservation: read one proposal's source-local observation state.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";

const ThreadGitArcObservationContext = createContext<Readonly<Record<string, ThreadGitArcProposalObservation>> | null>(null);

export function ThreadGitArcObservationProvider({
  children,
  proposals,
}: {
  children: ReactNode;
  proposals: Readonly<Record<string, ThreadGitArcProposalObservation>>;
}) {
  return (
    <ThreadGitArcObservationContext.Provider value={proposals}>
      {children}
    </ThreadGitArcObservationContext.Provider>
  );
}

export function useThreadGitArcProposalObservation(proposalId: string | null) {
  const proposals = useContext(ThreadGitArcObservationContext);
  return {
    isObserved: proposals !== null,
    state: proposalId ? proposals?.[proposalId] ?? null : null,
  };
}
