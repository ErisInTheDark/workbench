/*
 * Exports:
 * - default ThreadGitArcFailure: render integrated typed or generic Git arc failures with recovery, live conflict threads, and bounded structured facts. Keywords: thread, git, arc, failure, conflict, recovery.
 */
"use client";

import { useContext } from "react";

import { describeGitArcFailure, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import ProjectFileLinkList from "../ProjectFileLinkList";
import { GitArcConflictIcon } from "./GitArcIcon";
import ThreadGitArcConflictList from "./ThreadGitArcConflictList";
import ThreadInlineCode from "./ThreadInlineCode";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import { useWorkbenchProjectThreadSidebar } from "../use-workbench-client";

type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

function identityKey(harness: string, threadId: string) {
  return `${harness.toLowerCase()}\0${threadId.toLowerCase()}`;
}

export default function ThreadGitArcFailure({
  failure,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  failure: GitArcFailure;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const presentationContext = useContext(ThreadGitArcPresentationContext);
  const resolvedProjectId = projectId ?? presentationContext?.projectId ?? null;
  const snapshot = useWorkbenchProjectThreadSidebar(resolvedProjectId);
  const presentation = describeGitArcFailure(failure);
  const conflicts = failure.code === "siblingClaimCollision" || failure.code === "planDrift" ? failure.conflicts : [];
  const conflictKeys = new Set(conflicts.map(({ owner }) => identityKey(owner.harness, owner.threadId)));
  const liveEntries = (snapshot?.entries ?? []).filter((entry): entry is ProviderThreadSidebarEntry => (
    entry.entryKind !== "draft" && conflictKeys.has(identityKey(entry.identity.harness, entry.identity.threadId))
  ));
  const liveKeys = new Set(liveEntries.map((entry) => identityKey(entry.identity.harness, entry.identity.threadId)));
  const missingOwners = conflicts.map(({ owner }) => owner).filter((owner) => !liveKeys.has(identityKey(owner.harness, owner.threadId)));
  const canRenderLiveThreads = Boolean(liveEntries.length && resolvedProjectId && presentationContext?.onOpenThread);
  const hasStructuredFacts = Boolean(
    (failure.code === "planDrift" && failure.commits.length)
    || failure.code === "acceptedProposals"
    || canRenderLiveThreads
    || missingOwners.length,
  );

  const message = failure.code === "missingArcRef"
    ? <>There is no git arc by the <ThreadInlineCode>{failure.ref}</ThreadInlineCode> ref.</>
    : failure.code === "proposalAlreadyCommitted"
      ? <>Commit <span className="font-medium">{failure.proposalTitle}</span> already exists at <ThreadInlineCode>{failure.commitSha.slice(0, 8)}</ThreadInlineCode>.</>
    : presentation.message;

  return (
    <section
      className="mt-1.5"
      data-thread-git-arc-failure={failure.code}
    >
      <div
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-[0.45rem] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] px-2.5 py-1.5 text-danger"
        data-thread-git-arc-failure-panel="true"
      >
        <GitArcConflictIcon className="col-start-1 row-start-1 size-4 shrink-0 self-center" />
        <p className="col-start-2 row-start-1 m-0 min-w-0 leading-[1.45]" data-thread-git-arc-failure-message="true">{message}</p>
        {presentation.userHint ? (
          <p className="col-start-2 row-start-2 m-0 text-[0.78em] italic leading-[1.45] text-[color:color-mix(in_srgb,var(--danger)_78%,var(--text)_22%)]" data-thread-git-arc-failure-hint="true">
            {presentation.userHint}
          </p>
        ) : null}
      </div>
      {hasStructuredFacts ? (
        <div className="mt-1 text-text" data-thread-git-arc-failure-facts="true">
          {failure.code === "planDrift" && failure.commits.length ? (
            <div className="space-y-1 py-1 text-[0.9em] text-muted">
              {failure.commits.map(({ commit, paths, subject }) => (
                <div key={commit}>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono">{commit.slice(0, 8)}</span>
                    <span className="min-w-0 truncate text-text">{subject || "No commit subject"}</span>
                  </div>
                  <ProjectFileLinkList paths={paths} projectFilePaths={projectFilePaths} projectId={resolvedProjectId} projectRootPath={projectRootPath ?? ""} workspaceRoots={workspaceRoots} />
                </div>
              ))}
            </div>
          ) : null}
          {failure.code === "acceptedProposals" ? (
            <ul className="m-0 flex flex-col gap-1 py-1 text-[0.9em]" data-thread-git-arc-accepted-proposals="true">
              {failure.proposals.map(({ commitSha, proposalId, title }) => (
                <li className="flex min-w-0 flex-wrap items-baseline gap-x-2" key={proposalId}>
                  <span className="font-medium text-text">{title || "Accepted commit"}</span>
                  <ThreadInlineCode>{commitSha.slice(0, 8)}</ThreadInlineCode>
                </li>
              ))}
            </ul>
          ) : null}
          {canRenderLiveThreads ? (
            <ThreadGitArcConflictList
              entries={liveEntries.map((entry) => ({ entry, paths: [] }))}
              onOpenThread={presentationContext!.onOpenThread!}
              projectId={resolvedProjectId!}
            />
          ) : null}
          {missingOwners.length ? (
            <ul className="m-0 flex flex-col gap-1 py-1 text-[0.9em]">
              {missingOwners.map((owner) => (
                <li className="min-w-0" key={identityKey(owner.harness, owner.threadId)}>
                  <span className="font-medium text-text">{owner.title || owner.intentName}</span>
                  <span className="ml-2 text-muted">{owner.lifecycle}</span>
                  <span className="ml-2 font-mono text-muted">{owner.checkpointCommit.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
