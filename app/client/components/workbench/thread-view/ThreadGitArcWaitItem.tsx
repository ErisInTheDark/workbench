/*
 * Exports:
 * - default ThreadGitArcWaitItem: one wb git arc wait, CLI or MCP; a card over the live sibling claims while it waits, then
 *   the started arc's card with how long it waited.
 */
"use client";

import { useContext, type ComponentProps } from "react";

import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import { ObservedThreadGitArcIntersectionCard } from "./ThreadGitArcIntersectionCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import WorkbenchClientContext from "../workbench-client-context";
import { GitArcWaitIcon, LoaderIcon } from "../workbench-icons";
import ThreadCard from "./ThreadCard";

type GitArcItemProps = ComponentProps<typeof ThreadGitArcItem>;

export default function ThreadGitArcWaitItem({
  durationMs,
  failureReason,
  interruptedBySteer = false,
  outcome,
  planRef,
  receipt,
  threadId,
  typedFailure = null,
}: Pick<GitArcItemProps, "failureReason" | "receipt" | "typedFailure"> & {
  durationMs: number | null;
  interruptedBySteer?: boolean;
  outcome: ThreadCommandExecutionOutcome;
  /** The inactive plan waited on; null waits on the registered plan. */
  planRef: string | null;
  threadId: string;
}) {
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);
  const hasClient = useContext(WorkbenchClientContext) !== null;
  if (outcome !== "inProgress") {
    return (
      <ThreadGitArcItem
        commandIntent={{ action: "start", intentName: null, paths: [], ref: planRef }}
        durationMs={durationMs}
        durationPresentation="waited"
        failureReason={failureReason}
        interruptedBySteer={interruptedBySteer}
        outcome={outcome}
        receipt={receipt}
        typedFailure={typedFailure}
      />
    );
  }
  // The live list leases sibling rows and links to them, which needs a mounted client (not the render lab).
  if (!hasClient || !gitArcPresentation?.projectId) return null;
  // Open while it waits: who holds the claims is the one thing worth seeing until they clear.
  return (
    <ThreadCard
      defaultOpen
      icon={<GitArcWaitIcon size={16} />}
      meta={[<LoaderIcon key="running" size={14} />]}
      summary={<span>Waiting for Git arc claims</span>}
    >
      <ObservedThreadGitArcIntersectionCard chrome="flush" harness={gitArcPresentation.harness} mode="wait" threadId={threadId} />
    </ThreadCard>
  );
}
