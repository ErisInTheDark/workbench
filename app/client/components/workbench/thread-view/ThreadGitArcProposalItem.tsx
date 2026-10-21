/*
 * Exports:
 * - default ThreadGitArcProposalItem: a transcript proposal as a stable, collapsed "Proposed <title>" Git arc card whose opened content is the readonly commit card, read on demand.
 */
"use client";

import { useEffect } from "react";

import type { GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { GitCheckpointCommitCommandIntent, ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, { type CheckpointCommitCardState } from "./ThreadCheckpointCommitCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { useThreadGitArcProposalObservation } from "./ThreadGitArcObservationContext";

/** Mounted only once the card is opened, so closed transcript proposals never read Git. */
function ThreadGitArcProposalPreview({
  intent,
  proposalId,
  sourceItemId,
}: { intent: GitCheckpointCommitCommandIntent | null; proposalId: string; sourceItemId: string }) {
  const { isObserved, observe, state, summary } = useThreadGitArcProposalObservation(proposalId);
  useEffect(() => observe?.(proposalId), [observe, proposalId]);
  const cardState: Exclude<CheckpointCommitCardState, { status: "idle" }> = state?.status === "loaded"
    ? { proposal: state.proposal, status: "loaded" }
    : state?.status === "failed"
      ? { error: state.error, failure: state.failure, retryable: false, status: "error" }
      : summary
        ? { status: "summary", summary }
        // Surfaces without Git arc observation can only show what the agent asked for.
        : !isObserved && intent?.title.trim()
          ? { status: "summary", summary: { description: intent.description, title: intent.title, totals: null } }
          : { status: "pending" };
  const fallbackTitle = cardState.status === "pending" ? intent?.title.trim() : undefined;
  return (
    <ThreadCheckpointCommitCard
      expanded
      message={fallbackTitle ? { availability: { description: false, title: true }, description: "", title: fallbackTitle } : undefined}
      sourceItemId={sourceItemId}
      state={cardState}
    />
  );
}

export default function ThreadGitArcProposalItem({
  durationMs,
  failureReason,
  intent,
  interruptedBySteer = false,
  outcome,
  proposalId,
  sourceItemId,
  typedFailure,
}: {
  durationMs: number | null;
  failureReason?: string | null;
  intent: GitCheckpointCommitCommandIntent | null;
  interruptedBySteer?: boolean;
  outcome: ThreadCommandExecutionOutcome;
  proposalId: string | null;
  sourceItemId: string;
  typedFailure?: GitArcFailure | null;
}) {
  const { summary } = useThreadGitArcProposalObservation(proposalId);
  const name = intent?.title.trim() || summary?.title || "commit proposal";
  return (
    <ThreadGitArcItem
      commandIntent={{ action: "propose", intentName: null, paths: intent?.paths ?? [], proposalId, ref: null }}
      durationMs={durationMs}
      failureReason={failureReason}
      interruptedBySteer={interruptedBySteer}
      name={name}
      operationDetails={proposalId && outcome === "completed" ? (
        <ThreadGitArcProposalPreview intent={intent} proposalId={proposalId} sourceItemId={sourceItemId} />
      ) : null}
      outcome={outcome}
      receipt={null}
      typedFailure={typedFailure}
    />
  );
}
