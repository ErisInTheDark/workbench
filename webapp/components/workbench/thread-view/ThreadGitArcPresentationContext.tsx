/*
 * Exports:
 * - default ThreadGitArcPresentationContext: identify the active harness and proposal-id set hoisted into terminal thread controls. Keywords: thread, git, arc, proposal, presentation.
 * - getGitArcClaimReleaseAction: choose clean unclaim or dirty restore from the active comparison. Keywords: claim, compare, action.
 */
"use client";

import { createContext } from "react";

import type { WorkbenchHarness } from "../../../lib/types";

export interface ThreadGitArcPresentation {
  harness: WorkbenchHarness;
  /** @deprecated Transitional input for pre-grouped tests and callers. */
  hoistedProposalId?: string | null;
  hoistedProposalIds?: ReadonlySet<string>;
}

type ReleaseAction = "restore" | "unclaim";

export function getGitArcClaimReleaseAction(changeCount: number): ReleaseAction {
  return changeCount > 0 ? "restore" : "unclaim";
}

const ThreadGitArcPresentationContext = createContext<ThreadGitArcPresentation | null>(null);

export default ThreadGitArcPresentationContext;
