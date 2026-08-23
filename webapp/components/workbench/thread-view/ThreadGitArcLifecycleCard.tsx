/*
 * Exports:
 * - default ThreadGitArcLifecycleCard: render ordered proposals and claim resolution for one durable Git arc lifecycle. Keywords: thread, git, arc, proposal, restore, resolved.
 */
"use client";

import { useEffect, useState } from "react";

import { GitCheckpointCompareResultSchema } from "../../../lib/workbench/git/checkpoint-contracts";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  parseGitArcFailureEnvelope,
  type GitArcFailure,
  type GitArcFailureAction,
} from "../../../lib/workbench/git/git-arc-failures";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import reportClientSchemaError from "../../../lib/workbench/report-client-schema-error";
import type { GitArcProposalStatus } from "../../../lib/workbench/git/git-arc-storage";
import type { WorkbenchGitArcLifecycleState, WorkbenchHarnessId } from "../../../lib/workbench/thread/thread-state";
import PrimaryButton from "../PrimaryButton";
import GitArcIcon from "./GitArcIcon";
import ThreadCheckpointCommitItem from "./ThreadCheckpointCommitItem";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadReloadScopeList from "./ThreadReloadScopeList";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";

type ReleaseAction = "restore" | "unclaim";
type ClaimChangeState = "clean" | "dirty" | "error" | "loading";
type LifecyclePresentation = Omit<WorkbenchGitArcLifecycleState, "phase" | "proposals"> & {
  phase?: "active" | "resolved";
  proposalIds?: string[];
  proposals: Array<{ proposalId: string; status: GitArcProposalStatus }>;
};

async function requireGitArcResponse(response: Response, action: GitArcFailureAction, fallback: string) {
  if (response.ok) return response;
  const text = await response.text();
  const envelope = parseGitArcFailureEnvelope(text, (error) => {
    reportClientSchemaError("Rejected Git arc lifecycle failure response", error);
  });
  throw new GitArcFailureException(envelope?.gitArcFailure ?? createGitArcOperationRejected(action, envelope?.error || text.trim() || fallback));
}

export default function ThreadGitArcLifecycleCard({
  claim,
  cwd,
  harness,
  onReleased,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadId,
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
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const phase = claim.phase ?? (claim.claimedPaths.length ? "active" : "resolved");
  const visibleProposals = claim.proposals.filter(({ status }) => status === "proposed" || status === "committed");
  const [activeAction, setActiveAction] = useState<ReleaseAction | null>(null);
  const [changeState, setChangeState] = useState<ClaimChangeState>("loading");
  const [failure, setFailure] = useState<GitArcFailure | null>(null);

  useEffect(() => {
    if (phase === "resolved" || !claim.claimedPaths.length) {
      setChangeState("clean");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/git-checkpoint", {
          body: JSON.stringify({ action: "compare", cwd, harness, threadId }),
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        await requireGitArcResponse(response, "compare", "Unable to inspect the active Git arc claim.");
        const parsed = GitCheckpointCompareResultSchema.safeParse(await response.json());
        if (!parsed.success) {
          reportClientSchemaError("Rejected Git arc comparison response", parsed.error);
          throw new Error("Workbench returned an invalid Git arc comparison.");
        }
        setChangeState(getGitArcClaimReleaseAction(parsed.data.changes.length) === "restore" ? "dirty" : "clean");
      } catch (compareError) {
        if (controller.signal.aborted) return;
        setChangeState("error");
        setFailure(compareError instanceof GitArcFailureException
          ? compareError.failure
          : createGitArcOperationRejected("compare", compareError instanceof Error ? compareError.message : "Unable to inspect the active Git arc claim."));
      }
    })();
    return () => controller.abort();
  }, [claim.checkpointCommit, claim.claimedPaths.length, cwd, harness, phase, threadId]);

  const release = async (action: ReleaseAction) => {
    if (activeAction) return;
    setActiveAction(action);
    setFailure(null);
    try {
      const response = await fetch("/api/git-checkpoint", {
        body: JSON.stringify(action === "restore" ? {
          action: "restore",
          checkpointCommit: claim.checkpointCommit,
          confirmRestore: true,
          cwd,
          harness,
          paths: claim.claimedPaths,
          threadId,
        } : {
          action: "arcRemove",
          cwd,
          harness,
          paths: claim.claimedPaths,
          threadId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await requireGitArcResponse(response, action === "restore" ? "restore" : "arcRemove", "Unable to release the Git arc claim.");
      await onReleased();
    } catch (releaseError) {
      setFailure(releaseError instanceof GitArcFailureException
        ? releaseError.failure
        : createGitArcOperationRejected(
          action === "restore" ? "restore" : "arcRemove",
          releaseError instanceof Error ? releaseError.message : "Unable to release the Git arc claim.",
        ));
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <div className="my-2 w-full" data-thread-git-arc-lifecycle="true">
      <section className="w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]" data-thread-git-arc-lifecycle-card="true">
        {visibleProposals.length ? (
          visibleProposals.map(({ proposalId }, index) => (
            <div
              className={index ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" : undefined}
              data-thread-git-arc-proposal-separator={index ? "true" : undefined}
              key={proposalId}
            >
              <ThreadCheckpointCommitItem
                commandOutcome="completed"
                cwd={cwd}
                embedded
                harness={harness}
                hoisted
                intent={null}
                projectFilePaths={projectFilePaths}
                projectId={projectId}
                projectRootPath={projectRootPath}
                proposalId={proposalId}
                sourceItemId={`lifecycle-proposal:${proposalId}`}
                threadId={threadId}
                workspaceRoots={workspaceRoots}
              />
            </div>
          ))
        ) : (
          <div className="px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-[0.82em] leading-[1.45]">
              <GitArcIcon action="start" />
              <span className="min-w-0 flex-1 truncate font-medium text-text">{claim.intentName}</span>
              <span className="font-mono text-[0.86em] text-muted">{claim.checkpointCommit.slice(0, 8)}</span>
            </div>
            {claim.intentDescription ? <p className="m-0 mt-1 pl-6 text-[0.76em] leading-[1.45] text-muted">{claim.intentDescription}</p> : null}
          </div>
        )}
        {phase !== "resolved" ? (
          <div
            className={`${visibleProposals.length ? "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] " : ""}px-3 py-2`}
            data-thread-git-arc-resolution="true"
            data-thread-git-arc-resolution-separator={visibleProposals.length ? "true" : undefined}
          >
            <ThreadReloadScopeList scopes={claim.reloadScopes ?? []} />
            <ThreadDisclosure
              contentClassName="mt-1 pl-1"
              summary={(
                <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span>{claim.claimedPaths.length} claimed {claim.claimedPaths.length === 1 ? "file" : "files"}</span>
                  <span className="inline-flex min-w-0 items-center justify-end gap-2" data-thread-summary-action="true">
                    {changeState === "dirty" ? (
                      <PrimaryButton
                        className="!px-3 !py-1.5 !text-[0.76rem]"
                        disabled={activeAction !== null}
                        holdToConfirmMs={2000}
                        onClick={() => void release("restore")}
                        tone="danger"
                      >
                        {activeAction === "restore" ? "Restoring…" : "Restore & unclaim"}
                      </PrimaryButton>
                    ) : changeState === "clean" ? (
                      <PrimaryButton className="!px-3 !py-1.5 !text-[0.76rem]" disabled={activeAction !== null} onClick={() => void release("unclaim")}>
                        {activeAction === "unclaim" ? "Unclaiming…" : "Unclaim files"}
                      </PrimaryButton>
                    ) : changeState === "loading" ? <span className="text-[0.74em] text-muted">Checking claimed files…</span> : null}
                  </span>
                </span>
              )}
              summaryClassName="text-[0.76em] leading-[1.45] text-muted"
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
