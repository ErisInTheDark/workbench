/*
 * Exports:
 * - default ThreadGitArcPresentationContext: identify the active harness and the one proposal hoisted into terminal thread controls. Keywords: thread, git, arc, proposal, presentation.
 * - getGitArcClaimReleaseAction: choose clean unclaim or dirty restore from the active comparison. Keywords: claim, compare, action.
 */
"use client";

import { createContext } from "react";

import type { WorkbenchHarness } from "../../../lib/types";

export interface ThreadGitArcPresentation {
  harness: WorkbenchHarness;
  hoistedProposalId: string | null;
}

type ReleaseAction = "restore" | "unclaim";

export function getGitArcClaimReleaseAction(changeCount: number): ReleaseAction {
  return changeCount > 0 ? "restore" : "unclaim";
}

const ThreadGitArcPresentationContext = createContext<ThreadGitArcPresentation | null>(null);

export default ThreadGitArcPresentationContext;
