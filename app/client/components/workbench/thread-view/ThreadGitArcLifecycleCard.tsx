/*
 * Exports:
 * - default ThreadGitArcLifecycleCard: render ordered proposals and, once the turn stops, claim resolution for one durable Git arc lifecycle.
 */
"use client";

import { useEffect, useState } from "react";

import {
  createGitArcOperationRejected,
  GitArcFailureException,
  type GitArcFailure,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkbenchGitArcLifecycleState, WorkbenchHarnessId, WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import PrimaryButton from "../PrimaryButton";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { BinIcon, ResetIcon } from "../workbench-icons";
import GitArcIcon, { GitArcClaimIcon, GitArcUnclaimedIcon } from "./GitArcIcon";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcProposalList from "./ThreadGitArcProposalList";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";

type LifecycleAction = "discardStash" | "restore" | "restoreAndUnclaim" | "stash" | "unclaim" | "unstash";
type ClaimChangeState = "clean" | "dirty" | "error" | "loading";
type LifecyclePresentation = Omit<WorkbenchGitArcLifecycleState, "phase"> & {
  phase?: "active" | "stashed" | "resolved";
  proposalIds?: string[];
  stashedPaths?: string[];
};

export default function ThreadGitArcLifecycleCard ({
  claim,
  commitActions,
  cwd,
  harness,
  projectFilePaths,
  projectId,
  projectRootPath,
  running,
  threadId,
  threadLifecycle,
  workspaceRoots,
}: {
  claim: LifecyclePresentation;
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  /** A running turn still owns its claims, so only proposals render. */
  running: boolean;
  threadId: string;
  threadLifecycle: WorkbenchThreadLifecycle;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const daemon = useWorkbenchDaemonClient();
  const phase = claim.phase ?? (claim.claimedPaths.length ? "active" : "resolved");
  const visibleProposals = claim.proposals.filter(({ status }) => status === "proposed" || status === "committed");
  const isShiftPressed = useNonTextInputShiftKey();
  const [activeAction, setActiveAction] = useState<LifecycleAction | null>(null);
  const [changeState, setChangeState] = useState<ClaimChangeState>("loading");
  const [conflictedPaths, setConflictedPaths] = useState<string[]>([]);
  const [failure, setFailure] = useState<GitArcFailure | null>(null);
  const memberRefs = claim.members?.filter(member => member.claimedPaths.length)
    .map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })) ?? [];
  const stashWouldReplace = Boolean(claim.stashedPaths?.length);

  useEffect(() => {
    if (running || phase !== "active" || !claim.claimedPaths.length) {
      setChangeState("clean");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const comparison = await daemon.git.arc.compare({ cwd, harness, refs: [], roots: [], threadId });
        setChangeState(getGitArcClaimReleaseAction(
          comparison.changes.length,
          comparison.hasUncommittedChanges,
        ) === "restore" ? "dirty" : "clean");
      } catch (compareError) {
        if (controller.signal.aborted) return;
        setChangeState("error");
        setFailure(compareError instanceof GitArcFailureException
          ? compareError.failure
          : createGitArcOperationRejected("compare", compareError instanceof Error ? compareError.message : "Unable to inspect the active Git arc claim."));
      }
    })();
    return () => controller.abort();
  }, [claim.checkpointCommit, claim.claimedPaths.length, cwd, daemon, harness, phase, running, threadId]);

  const runAction = async (action: LifecycleAction) => {
    if (activeAction) return;
    setActiveAction(action);
    setFailure(null);
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
      if (action === "restore") setChangeState("clean");
    } catch (releaseError) {
      setFailure(releaseError instanceof GitArcFailureException
        ? releaseError.failure
        : createGitArcOperationRejected(
          action === "unclaim" ? "arcRelease" : action === "stash" ? "arcStash" : action === "unstash" ? "arcUnstash"
            : action === "discardStash" ? "arcDiscardStash" : "restore",
          releaseError instanceof Error ? releaseError.message : "Unable to release the Git arc claim.",
        ));
    } finally {
      setActiveAction(null);
    }
  };

  if (phase === "resolved" && !visibleProposals.length && !claim.stashedPaths?.length) return null;
  const showCombinedAction = activeAction === "restoreAndUnclaim" || (activeAction === null && isShiftPressed);
  const sections = running ? [] : [
    ...(claim.claimedPaths.length ? [{ phase: "active" as const, paths: claim.claimedPaths }] : []),
    ...(claim.stashedPaths?.length ? [{ phase: "stashed" as const, paths: claim.stashedPaths }] : []),
  ];
  if (!visibleProposals.length && !sections.length) return null;

  return (
    <div className="my-2 w-full" data-thread-git-arc-lifecycle="true">
      <section className="w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2" data-thread-git-arc-lifecycle-card="true">
        {visibleProposals.length ? (
          <ThreadGitArcProposalList
            acceptance={claim.acceptance ?? null}
            commitActions={commitActions}
            cwd={cwd}
            harness={harness}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            proposals={visibleProposals}
            running={running}
            stackLayers={claim.stackLayers ?? []}
            threadId={threadId}
            workspaceRoots={workspaceRoots}
          />
        ) : null}
        {sections.map(({ phase, paths: lifecyclePaths }, index) => (
          <div
            key={phase}
            className={`
              ${visibleProposals.length || index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" : ""}
              px-3 py-2
            `}
            data-thread-git-arc-resolution="true"
            data-thread-git-arc-resolution-separator={visibleProposals.length ? "true" : undefined}
          >
            <ThreadDisclosure
              contentClassName="mt-1 pl-1"
              summary={(
                <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1.5">
                    {phase === "stashed" ? <GitArcIcon action="stash" size={14} /> : <GitArcClaimIcon size={14} />}
                    {lifecyclePaths.length} {phase === "stashed" ? "stashed" : "claimed"} {lifecyclePaths.length === 1 ? "file" : "files"}
                  </span>
                  <span className="inline-flex min-w-0 items-center justify-end gap-2" data-thread-summary-action="true">
                    {phase === "stashed" ? (
                      <>
                        <PrimaryButton
                          className="!px-3 !py-1.5 !text-[0.76rem]"
                          disabled={activeAction !== null}
                          holdToConfirmMs={2000}
                          onClick={() => void runAction("discardStash")}
                          pendingHalo={activeAction === "discardStash"}
                          tone="danger"
                        >
                          <BinIcon className="mr-1.5" size={14} />
                          {activeAction === "discardStash" ? "Discarding…" : "Discard"}
                        </PrimaryButton>
                        <PrimaryButton className="!px-3 !py-1.5 !text-[0.76rem]" disabled={activeAction !== null} onClick={() => void runAction("unstash")} pendingHalo={activeAction === "unstash"}>
                          <GitArcIcon action="unstash" className="mr-1.5" size={14} />
                          {activeAction === "unstash" ? "Restoring…" : "Restore"}
                        </PrimaryButton>
                      </>
                    ) : null}
                    {phase === "active" && changeState === "dirty" ? (
                      showCombinedAction ? (
                        <PrimaryButton
                          key="restore-and-unclaim"
                          className="!px-3 !py-1.5 !text-[0.76rem]"
                          disabled={activeAction !== null}
                          holdToConfirmMs={2000}
                          onClick={() => void runAction("restoreAndUnclaim")}
                          pendingHalo={activeAction === "restoreAndUnclaim"}
                          tone="danger"
                        >
                          <ResetIcon className="mr-1.5" size={14} />
                          {activeAction === "restoreAndUnclaim" ? "Reverting & unclaiming…" : "Revert & unclaim"}
                        </PrimaryButton>
                      ) : (
                        <>
                          <PrimaryButton
                            key="restore"
                            className="!px-3 !py-1.5 !text-[0.76rem]"
                            disabled={activeAction !== null}
                            holdToConfirmMs={2000}
                            onClick={() => void runAction("restore")}
                            pendingHalo={activeAction === "restore"}
                            tone="danger"
                          >
                            <ResetIcon className="mr-1.5" size={14} />
                            {activeAction === "restore" ? "Reverting…" : "Revert"}
                          </PrimaryButton>
                          <PrimaryButton
                            key="unclaim"
                            className="!px-3 !py-1.5 !text-[0.76rem]"
                            disabled={activeAction !== null}
                            onClick={() => void runAction("unclaim")}
                            pendingHalo={activeAction === "unclaim"}
                          >
                            <GitArcUnclaimedIcon className="mr-1.5" size={14} />
                            {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim"}
                          </PrimaryButton>
                        </>
                      )
                    ) : phase === "active" && changeState === "clean" ? (
                      <PrimaryButton className="!px-3 !py-1.5 !text-[0.76rem]" disabled={activeAction !== null} onClick={() => void runAction("unclaim")} pendingHalo={activeAction === "unclaim"}>
                        <GitArcUnclaimedIcon className="mr-1.5" size={14} />
                        {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim"}
                      </PrimaryButton>
                    ) : phase === "active" && changeState === "loading" ? <span className="text-[0.74em] text-fg/muted">Checking claimed files…</span> : null}
                    {phase === "active" ? (
                      <PrimaryButton className="!px-3 !py-1.5 !text-[0.76rem]" disabled={activeAction !== null || stashWouldReplace} title={stashWouldReplace ? "Restore or discard the existing stash first." : undefined} onClick={() => void runAction("stash")} pendingHalo={activeAction === "stash"}>
                        <GitArcIcon action="stash" className="mr-1.5" size={14} />
                        {activeAction === "stash" ? "Stashing…" : "Stash"}
                      </PrimaryButton>
                    ) : null}
                  </span>
                </span>
              )}
              summaryClassName="text-[0.76em] leading-[1.45] text-fg/muted"
            >
              {phase === "stashed" ? (
                <p className="m-0 px-2 pb-1 text-[0.76em] text-fg/muted">Discard stash permanently loses the saved changes. Current workspace files stay as they are.</p>
              ) : null}
              <ThreadClaimedFileList
                marker={phase === "stashed" ? "unclaimed" : undefined}
                paths={lifecyclePaths}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            </ThreadDisclosure>
          </div>
        ))}
        {failure || conflictedPaths.length ? (
          <div className="px-3 pb-2">
            {failure ? (
              <ThreadGitArcFailure
                failure={failure}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            ) : null}
            {conflictedPaths.length ? (
              <div className="mt-2 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] pt-2">
                <ThreadClaimedFileList
                  label="Resolve conflict markers"
                  marker="dirty"
                  paths={conflictedPaths}
                  projectFilePaths={projectFilePaths}
                  projectId={projectId}
                  projectRootPath={projectRootPath}
                  workspaceRoots={workspaceRoots}
                />
                <p className="m-0 px-2 pb-1 text-[0.76em] text-fg/muted">Edit the markers directly. No Git continuation or abort command is required.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
