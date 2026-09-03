/*
 * Exports:
 * - default ThreadGitArcPresentationContext: identify the active harness and proposal-id set hoisted into terminal thread controls. Keywords: thread, git, arc, proposal, presentation.
 * - ThreadGitArcPresentation: live Git arc facts used by nested thread presentation. Keywords: thread, git, arc, presentation, context.
 * - getGitArcClaimReleaseAction: choose clean unclaim or dirty restore from the active comparison. Keywords: claim, compare, action.
 */
"use client";

import { createContext } from "react";

import type { GitCheckpointCommitCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";

export interface ThreadGitArcPresentation {
  harness: WorkbenchHarness;
  hasActiveGitArc?: boolean;
  /** @deprecated Transitional input for pre-grouped tests and callers. */
  hoistedProposalId?: string | null;
  hoistedProposalIds?: ReadonlySet<string>;
  onOpenThread?: (target: WorkbenchThreadTarget) => void;
  projectId?: string | null;
  proposalIntents?: ReadonlyMap<string, GitCheckpointCommitCommandIntent>;
}

type ReleaseAction = "restore" | "unclaim";

export function getGitArcClaimReleaseAction(changeCount: number, hasUncommittedChanges?: boolean): ReleaseAction {
  if (hasUncommittedChanges !== undefined) return hasUncommittedChanges ? "restore" : "unclaim";
  return changeCount > 0 ? "restore" : "unclaim";
}

const ThreadGitArcPresentationContext = createContext<ThreadGitArcPresentation | null>(null);

export default ThreadGitArcPresentationContext;
