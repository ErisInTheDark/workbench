/*
 * Exports:
 * - ThreadCheckpointCommitSourceAnchor/ThreadCheckpointCommitTargetAnchor: mark transcript and terminal placement for one proposal.
 * - ThreadCheckpointCommitAnchorRegistry: notify proposal portals when independently rendered anchors mount or unmount.
 * - default ThreadCheckpointCommitPortalLayer: keep one proposal controller mounted while moving its DOM host between anchors.
 */
"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { ThreadGitArcProposalSource } from "./thread-git-arc-presentation";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";

type ThreadCheckpointCommitPlacement = "source" | "target";

interface ThreadCheckpointCommitAnchorEntry {
  listeners: Set<() => void>;
  source: HTMLDivElement | null;
  target: HTMLDivElement | null;
}

export class ThreadCheckpointCommitAnchorRegistry {
  readonly #entries = new Map<string, ThreadCheckpointCommitAnchorEntry>();

  #entry(proposalId: string) {
    const existing = this.#entries.get(proposalId);
    if (existing) return existing;
    const entry: ThreadCheckpointCommitAnchorEntry = {
      listeners: new Set(),
      source: null,
      target: null,
    };
    this.#entries.set(proposalId, entry);
    return entry;
  }

  #retire(proposalId: string, entry: ThreadCheckpointCommitAnchorEntry) {
    if (!entry.source && !entry.target && !entry.listeners.size) this.#entries.delete(proposalId);
  }

  setAnchor(proposalId: string, placement: ThreadCheckpointCommitPlacement, anchor: HTMLDivElement | null) {
    const entry = this.#entry(proposalId);
    if (entry[placement] === anchor) return;
    entry[placement] = anchor;
    for (const listener of entry.listeners) listener();
    this.#retire(proposalId, entry);
  }

  subscribe(proposalId: string, listener: () => void) {
    const entry = this.#entry(proposalId);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      this.#retire(proposalId, entry);
    };
  }

  getDestination(
    proposalId: string,
    preferred: ThreadCheckpointCommitPlacement,
    parking: HTMLDivElement | null,
  ) {
    const entry = this.#entries.get(proposalId);
    const fallback = preferred === "source" ? "target" : "source";
    return entry?.[preferred] ?? entry?.[fallback] ?? parking;
  }
}

const anchorRegistry = new ThreadCheckpointCommitAnchorRegistry();

function anchorId(proposalId: string, placement: ThreadCheckpointCommitPlacement) {
  return `thread-checkpoint-proposal-${placement}-${encodeURIComponent(proposalId)}`;
}

function ThreadCheckpointCommitAnchor({
  className,
  placement,
  proposalId,
}: {
  className?: string;
  placement: ThreadCheckpointCommitPlacement;
  proposalId: string;
}) {
  const setAnchor = useCallback((anchor: HTMLDivElement | null) => {
    anchorRegistry.setAnchor(proposalId, placement, anchor);
  }, [placement, proposalId]);
  return (
    <div
      className={className}
      data-thread-checkpoint-proposal-source={placement === "source" ? proposalId : undefined}
      data-thread-checkpoint-proposal-target={placement === "target" ? proposalId : undefined}
      id={anchorId(proposalId, placement)}
      ref={setAnchor}
    />
  );
}

export function ThreadCheckpointCommitSourceAnchor({ proposalId }: { proposalId: string }) {
  return <ThreadCheckpointCommitAnchor placement="source" proposalId={proposalId} />;
}

export function ThreadCheckpointCommitTargetAnchor({ proposalId }: { proposalId: string }) {
  return <ThreadCheckpointCommitAnchor className="scroll-mt-6" placement="target" proposalId={proposalId} />;
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
    const reconcile = () => {
      const destination = anchorRegistry.getDestination(
        proposalId,
        hoisted ? "target" : "source",
        parkingRef.current,
      );
      if (destination && host.parentNode !== destination) {
        if (host.isConnected) destination.moveBefore(host, null);
        else destination.append(host);
      }
    };
    const unsubscribe = anchorRegistry.subscribe(proposalId, reconcile);
    reconcile();
    return () => {
      unsubscribe();
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
