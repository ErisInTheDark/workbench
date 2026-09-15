/*
 * Exports:
 * - default ThreadGitArcPresentationContext: provide active harness, plan and thread Git arc presentation actions.
 * - ThreadGitArcPresentation: describe live Git arc facts used by nested thread presentation.
 * - getGitArcClaimReleaseAction: choose clean unclaim or dirty restore from the active comparison.
 */
"use client";

import { createContext } from "react";

import type { GitCheckpointCommitCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchGitArcPlanState, WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";

export interface ThreadGitArcPresentation {
  gitArcPlan?: WorkbenchGitArcPlanState | null;
  harness: WorkbenchHarness;
  hasActiveGitArc?: boolean;
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
