/*
 * Exports:
 * - ThreadCheckpointCommitSourceAnchor/ThreadCheckpointCommitTargetAnchor: mark transcript and terminal placement for one proposal.
 * - default ThreadCheckpointCommitPortalLayer: keep one proposal controller mounted while moving its DOM host between anchors.
 */
"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { ThreadGitArcProposalSource } from "./thread-git-arc-presentation";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";

function anchorId(proposalId: string, placement: "source" | "target") {
  return `thread-checkpoint-proposal-${placement}-${encodeURIComponent(proposalId)}`;
}

export function ThreadCheckpointCommitSourceAnchor({ proposalId }: { proposalId: string }) {
  return <div data-thread-checkpoint-proposal-source={proposalId} id={anchorId(proposalId, "source")} />;
}

export function ThreadCheckpointCommitTargetAnchor({ proposalId }: { proposalId: string }) {
  return <div className="scroll-mt-6" data-thread-checkpoint-proposal-target={proposalId} id={anchorId(proposalId, "target")} />;
}

function ThreadCheckpointCommitPortal({
  cwd,
  harness,
  hoisted,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalId,
  source,
  threadId,
  workspaceRoots,
}: {
  cwd: string;
  harness: WorkbenchHarness;
  hoisted: boolean;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposalId: string;
  source: ThreadGitArcProposalSource | null;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const parkingRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const nextHost = document.createElement("div");
    nextHost.dataset.threadCheckpointProposalHost = proposalId;
    setHost(nextHost);
    return () => nextHost.remove();
  }, [proposalId]);

  useLayoutEffect(() => {
    if (!host) return;
    const preferred = document.getElementById(anchorId(proposalId, hoisted ? "target" : "source"));
    const fallback = document.getElementById(anchorId(proposalId, hoisted ? "source" : "target"));
    const destination = preferred ?? fallback;
    if (destination && host.parentNode !== destination) {
      if (host.isConnected) destination.moveBefore(host, null);
      else destination.append(host);
    }
    // Keep the host connected while React replaces either placement anchor.
    return () => {
      const parking = parkingRef.current;
      if (parking && host.isConnected && host.parentNode !== parking) parking.moveBefore(host, null);
    };
  }, [hoisted, host, proposalId]);

  return (
    <>
      <div className="h-0 w-full overflow-hidden" data-thread-checkpoint-proposal-parking={proposalId} ref={parkingRef} />
      {host ? createPortal(
        <ThreadCheckpointCommitController
          commandOutcome="completed"
          cwd={source?.cwd ?? cwd}
          embedded={hoisted}
          harness={harness}
          intent={source?.intent ?? null}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          proposalId={proposalId}
          sourceItemId={source?.sourceItemId ?? `lifecycle-proposal:${proposalId}`}
          threadId={threadId}
          workspaceRoots={workspaceRoots}
        />,
        host,
      ) : null}
    </>
  );
}

export default function ThreadCheckpointCommitPortalLayer({
  cwd,
  harness,
  hoistedProposalIds,
  lifecycleProposalIds,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalSources,
  threadId,
  workspaceRoots,
}: {
  cwd: string;
  harness: WorkbenchHarness;
  hoistedProposalIds: ReadonlySet<string>;
  lifecycleProposalIds: readonly string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposalSources: ReadonlyMap<string, ThreadGitArcProposalSource>;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const proposalIds = useMemo(
    () => Array.from(new Set([...proposalSources.keys(), ...lifecycleProposalIds])),
    [lifecycleProposalIds, proposalSources],
  );
  return proposalIds.map(proposalId => (
    <ThreadCheckpointCommitPortal
      cwd={cwd}
      harness={harness}
      hoisted={hoistedProposalIds.has(proposalId)}
      key={proposalId}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      proposalId={proposalId}
      source={proposalSources.get(proposalId) ?? null}
      threadId={threadId}
      workspaceRoots={workspaceRoots}
    />
  ));
}
