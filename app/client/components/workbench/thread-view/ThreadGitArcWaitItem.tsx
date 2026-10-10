/*
 * Exports:
 * - default ThreadGitArcWaitItem: one wb git arc wait, CLI or MCP; the live sibling intersection card while it waits, then the
 *   settled arc row with how long it waited.
 */
"use client";

import { useContext, type ComponentProps } from "react";

import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import { ObservedThreadGitArcIntersectionCard } from "./ThreadGitArcIntersectionCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

type GitArcItemProps = ComponentProps<typeof ThreadGitArcItem>;

export default function ThreadGitArcWaitItem({
  durationMs,
  failureReason,
  interruptedBySteer = false,
  outcome,
  projectFilePaths,
  projectId,
  projectRootPath,
  planRef,
  receipt,
  threadId,
  typedFailure = null,
  workspaceRoots,
}: Pick<GitArcItemProps, "failureReason" | "projectFilePaths" | "projectId" | "projectRootPath" | "receipt" | "typedFailure" | "workspaceRoots"> & {
  durationMs: number | null;
  interruptedBySteer?: boolean;
  outcome: ThreadCommandExecutionOutcome;
  /** The inactive plan waited on; null waits on the registered plan. */
  planRef: string | null;
  threadId: string;
}) {
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);
  if (outcome !== "inProgress") {
    return (
      <ThreadGitArcItem
        commandIntent={{ action: "start", intentName: null, paths: [], ref: planRef }}
        durationMs={durationMs}
        durationPresentation="waited"
        failureReason={failureReason}
        interruptedBySteer={interruptedBySteer}
        outcome={outcome}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        receipt={receipt}
        typedFailure={typedFailure}
        workspaceRoots={workspaceRoots}
      />
    );
  }
  if (!gitArcPresentation?.onOpenThread || !gitArcPresentation.projectId) return null;
  return (
    <ObservedThreadGitArcIntersectionCard
      harness={gitArcPresentation.harness}
      mode="wait"
      onOpenThread={gitArcPresentation.onOpenThread}
      threadId={threadId}
    />
  );
}
