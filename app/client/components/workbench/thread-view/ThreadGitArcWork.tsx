/*
 * Exports:
 * - ThreadGitArcWorkClaim: the observed Git arc work a thread shows: its proposals and claimed or stashed files.
 * - ThreadGitArcWorkProps: that work plus the commit wiring and Git request scope it needs.
 * - default ThreadGitArcWork: a thread's Git arc work: proposals, then claimed and stashed files whose revert, unclaim, stash and stash recovery wait for the turn to stop.
 */
"use client";

import { useState } from "react";

import {
  createGitArcOperationRejected,
  GitArcFailureException,
  type GitArcFailure,
} from "workbench-shared/workbench/git/git-arc-failures";
import type {
  WorkbenchGitArcLifecycleState,
  WorkbenchHarnessId,
  WorkbenchThreadGitCommitHistory,
} from "workbench-shared/workbench/thread/thread-state";
import PrimaryButton from "../../ui/PrimaryButton";
import Disclosure from "../../ui/Disclosure";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { BinIcon, ResetIcon } from "../workbench-icons";
import GitArcIcon, { GitArcClaimIcon, GitArcUnclaimIcon } from "./GitArcIcon";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import { useThreadGitArcClaimChanges } from "./ThreadGitArcObservationContext";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";
import ThreadGitArcProposalList from "./ThreadGitArcProposalList";

type ClaimAction = "discardStash" | "restore" | "restoreAndUnclaim" | "stash" | "unclaim" | "unstash";

export type ThreadGitArcWorkClaim = Omit<WorkbenchGitArcLifecycleState, "phase"> & {
  phase?: "active" | "stashed" | "resolved";
  stashedPaths?: string[];
};

export interface ThreadGitArcWorkProps {
  claim: ThreadGitArcWorkClaim | null;
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  history?: WorkbenchThreadGitCommitHistory;
  /** A running turn still owns its claims: they list, but their actions wait for the turn to stop. */
  running: boolean;
  threadId: string;
}

export default function ThreadGitArcWork ({
  claim,
  commitActions,
  cwd,
  harness,
  history,
  running,
  threadId,
}: ThreadGitArcWorkProps) {
  const daemon = useWorkbenchDaemonClient();
  const phase = claim?.phase ?? (claim?.claimedPaths.length ? "active" : "resolved");
  const visibleProposals = claim?.proposals.filter(({ status }) => status === "proposed" || status === "committed") ?? [];
  const isShiftPressed = useNonTextInputShiftKey();
  const [activeAction, setActiveAction] = useState<ClaimAction | null>(null);
  const [conflictedPaths, setConflictedPaths] = useState<string[]>([]);
  const [actionFailure, setActionFailure] = useState<GitArcFailure | null>(null);
  const memberRefs = claim?.members?.filter(member => member.claimedPaths.length)
    .map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })) ?? [];
  const stashWouldReplace = Boolean(claim?.stashedPaths?.length);
  const comparesClaim = !running && phase === "active" && Boolean(claim?.claimedPaths.length);
  // The thread store owns the comparison; without an observing thread nothing can say whether reverting is safe.
  const claimChanges = useThreadGitArcClaimChanges(comparesClaim);
  const comparison = claimChanges?.state ?? null;
  // Unclaim disowns regardless of dirt, so only revert waits on the comparison.
  const claimDirty = comparesClaim && comparison?.status === "loaded"
    && getGitArcClaimReleaseAction(comparison.changeCount, comparison.hasUncommittedChanges) === "restore";
  const comparisonLoading = comparesClaim && comparison?.status !== "loaded" && comparison?.status !== "failed";
  const failure = actionFailure ?? (comparison?.status === "failed" ? comparison.failure : null);

  const runAction = async (action: ClaimAction) => {
    if (!claim || activeAction) return;
    setActiveAction(action);
    setActionFailure(null);
    // A running comparison holds the repository read gate this mutation needs, and its answer is moot anyway.
    const releaseHold = claimChanges?.hold() ?? null;
    try {
      if (action === "stash" || action === "unstash") {
        const result = action === "stash"
          ? await daemon.git.arc.stash({ cwd, harness, threadId })
          : await daemon.git.arc.unstash({ cwd, harness, threadId });
        setConflictedPaths(result.conflictedPaths);
      } else if (action === "discardStash") {
        await daemon.git.arc.discardStash({ cwd, harness, threadId });
        setConflictedPaths([]);
      } else if (action === "restore" || action === "restoreAndUnclaim") {
        const confirmRestore = action === "restoreAndUnclaim";
        await daemon.git.arc.restore(memberRefs.length ? {
          confirmRestore,
          cwd,
          harness,
          ...(confirmRestore ? {} : { paths: claim.claimedPaths }),
          refs: memberRefs,
          roots: [],
          threadId,
        } : {
          checkpointCommit: claim.checkpointCommit,
          confirmRestore,
          cwd,
          harness,
          paths: claim.claimedPaths,
          refs: [],
          roots: [],
          threadId,
        });
      } else {
        await daemon.git.arc.release({
          cwd,
          disown: true,
          harness,
          threadId,
        });
      }
    } catch (actionError) {
      setActionFailure(actionError instanceof GitArcFailureException
        ? actionError.failure
        : createGitArcOperationRejected(
          action === "unclaim" ? "arcRelease" : action === "stash" ? "arcStash" : action === "unstash" ? "arcUnstash"
            : action === "discardStash" ? "arcDiscardStash" : "restore",
          actionError instanceof Error ? actionError.message : "Unable to release the Git arc claim.",
        ));
    } finally {
      // Releasing the hold re-reads, which covers a restore leaving the claimed paths unchanged.
      releaseHold?.();
      setActiveAction(null);
    }
  };

  const sections = [
    ...(claim?.claimedPaths.length ? [{ phase: "active" as const, paths: claim.claimedPaths }] : []),
    ...(claim?.stashedPaths?.length ? [{ phase: "stashed" as const, paths: claim.stashedPaths }] : []),
  ];
  const hasHistory = Boolean(history?.count);
  if (!visibleProposals.length && !hasHistory && !sections.length) return null;
  const showCombinedAction = activeAction === "restoreAndUnclaim" || (activeAction === null && isShiftPressed);

  return (
    <section className="w-full" data-thread-git-arc-work="true">
      {visibleProposals.length || hasHistory ? (
        <ThreadGitArcProposalList
          acceptance={claim?.acceptance ?? null}
          commitActions={commitActions}
          cwd={cwd}
          harness={harness}
          history={history}
          proposals={visibleProposals}
          stackLayers={claim?.stackLayers ?? []}
          standalone={!sections.length}
          threadId={threadId}
        />
      ) : null}
      {sections.map(({ phase: sectionPhase, paths }, index) => (
        <div
          key={sectionPhase}
          className={`
            ${visibleProposals.length || hasHistory || index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" : ""}
            px-3 py-2
          `}
          data-thread-git-arc-resolution="true"
          data-thread-git-arc-resolution-separator={visibleProposals.length || hasHistory ? "true" : undefined}
        >
          <Disclosure
            contentClassName="mt-1 pl-1"
            summary={(
              <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  {sectionPhase === "stashed" ? <GitArcIcon action="stash" size={14} /> : <GitArcClaimIcon size={14} />}
                  {paths.length} {sectionPhase === "stashed" ? "stashed" : "claimed"} {paths.length === 1 ? "file" : "files"}
                </span>
                {running ? null : (
                  <span className="inline-flex min-w-0 items-center justify-end gap-2" data-thread-summary-action="true">
                    {sectionPhase === "stashed" ? (
                      <>
                        <PrimaryButton
                          shape="compact"
                          disabled={activeAction !== null}
                          holdToConfirmMs={2000}
                          onClick={() => void runAction("discardStash")}
                          pendingHalo={activeAction === "discardStash"}
                          tone="danger"
                        >
                          <BinIcon className="mr-1.5" size={14} />
                          {activeAction === "discardStash" ? "Discarding…" : "Discard"}
                        </PrimaryButton>
                        <PrimaryButton shape="compact" disabled={activeAction !== null} onClick={() => void runAction("unstash")} pendingHalo={activeAction === "unstash"}>
                          <GitArcIcon action="unstash" className="mr-1.5" size={14} />
                          {activeAction === "unstash" ? "Restoring…" : "Restore"}
                        </PrimaryButton>
                      </>
                    ) : null}
                    {sectionPhase === "active" && comparisonLoading ? (
                      <span className="text-[0.74em] text-fg/muted">Checking claimed files…</span>
                    ) : null}
                    {sectionPhase === "active" && claimDirty && showCombinedAction ? (
                      <PrimaryButton
                        key="restore-and-unclaim"
                        shape="compact"
                        disabled={activeAction !== null}
                        holdToConfirmMs={2000}
                        onClick={() => void runAction("restoreAndUnclaim")}
                        pendingHalo={activeAction === "restoreAndUnclaim"}
                        tone="danger"
                      >
                        <ResetIcon className="mr-1.5" size={14} />
                        {activeAction === "restoreAndUnclaim" ? "Reverting & unclaiming…" : "Revert & unclaim"}
                      </PrimaryButton>
                    ) : sectionPhase === "active" ? (
                      <>
                        {claimDirty ? (
                          <PrimaryButton
                            key="restore"
                            shape="compact"
                            disabled={activeAction !== null}
                            holdToConfirmMs={2000}
                            onClick={() => void runAction("restore")}
                            pendingHalo={activeAction === "restore"}
                            tone="danger"
                          >
                            <ResetIcon className="mr-1.5" size={14} />
                            {activeAction === "restore" ? "Reverting…" : "Revert"}
                          </PrimaryButton>
                        ) : null}
                        <PrimaryButton
                          key="unclaim"
                          shape="compact"
                          disabled={activeAction !== null}
                          onClick={() => void runAction("unclaim")}
                          pendingHalo={activeAction === "unclaim"}
                        >
                          <GitArcUnclaimIcon className="mr-1.5" size={14} />
                          {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim"}
                        </PrimaryButton>
                      </>
                    ) : null}
                    {sectionPhase === "active" ? (
                      <PrimaryButton shape="compact" disabled={activeAction !== null || stashWouldReplace} title={stashWouldReplace ? "Restore or discard the existing stash first." : undefined} onClick={() => void runAction("stash")} pendingHalo={activeAction === "stash"}>
                        <GitArcIcon action="stash" className="mr-1.5" size={14} />
                        {activeAction === "stash" ? "Stashing…" : "Stash"}
                      </PrimaryButton>
                    ) : null}
                  </span>
                )}
              </span>
            )}
            summaryClassName="text-[0.76em] leading-[1.45] text-fg/muted"
          >
            {sectionPhase === "stashed" ? (
              <p className="m-0 px-2 pb-1 text-[0.76em] text-fg/muted">Discard stash permanently loses the saved changes. Current workspace files stay as they are.</p>
            ) : null}
            <ThreadClaimedFileList
              marker={sectionPhase === "stashed" ? "unclaimed" : undefined}
              paths={paths}
            />
          </Disclosure>
        </div>
      ))}
      {failure || conflictedPaths.length ? (
        <div className="px-3 pb-2">
          {failure ? (
            <ThreadGitArcFailure
              failure={failure}
            />
          ) : null}
          {conflictedPaths.length ? (
            <div className="mt-2 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] pt-2">
              <ThreadClaimedFileList
                label="Resolve conflict markers"
                marker="dirty"
                paths={conflictedPaths}
              />
              <p className="m-0 px-2 pb-1 text-[0.76em] text-fg/muted">Edit the markers directly. No Git continuation or abort command is required.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
