/*
 * Exports:
 * - default ThreadGitArcLifecycleCard: render ordered proposals and claim resolution for one durable Git arc lifecycle.
 */
"use client";

import { useEffect, useState } from "react";

import {
  createGitArcOperationRejected,
  GitArcFailureException,
  type GitArcFailure,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchGitArcLifecycleState, WorkbenchHarnessId, WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import PrimaryButton from "../PrimaryButton";
import { ThreadCheckpointCommitTargetAnchor } from "./ThreadCheckpointCommitPortalLayer";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";

type ReleaseAction = "restore" | "restoreAndUnclaim" | "unclaim";
type ClaimChangeState = "clean" | "dirty" | "error" | "loading";
type LifecyclePresentation = Omit<WorkbenchGitArcLifecycleState, "phase" | "proposals"> & {
  phase?: "active" | "resolved";
  proposalIds?: string[];
  proposals: Array<{ proposalId: string; status: GitArcProposalStatus }>;
};

export default function ThreadGitArcLifecycleCard({
  claim,
  cwd,
  harness,
  onReleased,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadId,
  threadLifecycle,
  workspaceRoots,
}: {
  claim: LifecyclePresentation;
  cwd: string;
  harness: WorkbenchHarnessId;
  onReleased: () => Promise<void>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadId: string;
  threadLifecycle: WorkbenchThreadLifecycle;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const daemon = useWorkbenchDaemonClient();
  const phase = claim.phase ?? (claim.claimedPaths.length ? "active" : "resolved");
  const visibleProposals = claim.proposals.filter(({ status }) => status === "proposed" || status === "committed");
  const isShiftPressed = useNonTextInputShiftKey();
  const [activeAction, setActiveAction] = useState<ReleaseAction | null>(null);
  const [changeState, setChangeState] = useState<ClaimChangeState>("loading");
  const [failure, setFailure] = useState<GitArcFailure | null>(null);
  const memberRefs = claim.members?.map(({ checkpointCommit, rootId }) => ({ ref: checkpointCommit, rootId })) ?? [];

  useEffect(() => {
    if (phase === "resolved" || !claim.claimedPaths.length) {
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
  }, [claim.checkpointCommit, claim.claimedPaths.length, cwd, daemon, harness, phase, threadId]);

  const release = async (action: ReleaseAction) => {
    if (activeAction) return;
    setActiveAction(action);
    setFailure(null);
    try {
      if (action === "restore" || action === "restoreAndUnclaim") {
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
      else await onReleased();
    } catch (releaseError) {
      setFailure(releaseError instanceof GitArcFailureException
        ? releaseError.failure
        : createGitArcOperationRejected(
          action === "unclaim" ? "arcRelease" : "restore",
          releaseError instanceof Error ? releaseError.message : "Unable to release the Git arc claim.",
        ));
    } finally {
      setActiveAction(null);
    }
  };

  if (phase === "resolved" && !visibleProposals.length) return null;
  const showCombinedAction = activeAction === "restoreAndUnclaim" || (activeAction === null && isShiftPressed);

  return (
    <div className="my-2 w-full" data-thread-git-arc-lifecycle="true">
      <section className="w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_2%,var(--app-bg-solid))]" data-thread-git-arc-lifecycle-card="true">
        {visibleProposals.length ? (
          visibleProposals.map(({ proposalId }, index) => (
            <div
              className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" : undefined}
              data-thread-git-arc-proposal-separator={index ? "true" : undefined}
              key={proposalId}
            >
              <ThreadCheckpointCommitTargetAnchor proposalId={proposalId} />
            </div>
          ))
        ) : null}
        {phase !== "resolved" ? (
          <div
            className={`${visibleProposals.length ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] " : ""}px-3 py-2`}
            data-thread-git-arc-resolution="true"
            data-thread-git-arc-resolution-separator={visibleProposals.length ? "true" : undefined}
          >
            <ThreadDisclosure
              contentClassName="mt-1 pl-1"
              summary={(
                <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span>{claim.claimedPaths.length} claimed {claim.claimedPaths.length === 1 ? "file" : "files"}</span>
                  <span className="inline-flex min-w-0 items-center justify-end gap-2" data-thread-summary-action="true">
                    {changeState === "dirty" ? (
                      showCombinedAction ? (
                        <PrimaryButton
                          key="restore-and-unclaim"
                          className="!px-3 !py-1.5 !text-[0.76rem]"
                          disabled={activeAction !== null}
                          holdToConfirmMs={2000}
                          onClick={() => void release("restoreAndUnclaim")}
                          tone="danger"
                        >
                          {activeAction === "restoreAndUnclaim" ? "Restoring & unclaiming…" : "Restore & unclaim"}
                        </PrimaryButton>
                      ) : (
                        <>
                          <PrimaryButton
                            key="restore"
                            className="!px-3 !py-1.5 !text-[0.76rem]"
                            disabled={activeAction !== null}
                            holdToConfirmMs={2000}
                            onClick={() => void release("restore")}
                            tone="danger"
                          >
                            {activeAction === "restore" ? "Restoring…" : "Restore files"}
                          </PrimaryButton>
                          <PrimaryButton
                            key="unclaim"
                            className="!px-3 !py-1.5 !text-[0.76rem]"
                            disabled={activeAction !== null}
                            onClick={() => void release("unclaim")}
                          >
                            {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim files"}
                          </PrimaryButton>
                        </>
                      )
                    ) : changeState === "clean" ? (
                      <PrimaryButton className="!px-3 !py-1.5 !text-[0.76rem]" disabled={activeAction !== null} onClick={() => void release("unclaim")}>
                        {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim files"}
                      </PrimaryButton>
                    ) : changeState === "loading" ? <span className="text-[0.74em] text-fg/muted">Checking claimed files…</span> : null}
                  </span>
                </span>
              )}
              summaryClassName="text-[0.76em] leading-[1.45] text-fg/muted"
            >
              <ThreadClaimedFileList
                paths={claim.claimedPaths}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            </ThreadDisclosure>
            {failure ? (
              <ThreadGitArcFailure
                failure={failure}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                workspaceRoots={workspaceRoots}
              />
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
