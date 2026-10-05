/*
 * Exports:
 * - default ThreadGitArcProposalList: hoisted proposal anchors, grouped into sealed stack layer disclosures, under a header that collapses unless a stopped thread has pending proposals, and offers stack-ordered commit all.
 */
"use client";

import { useState, useSyncExternalStore } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
import PrimaryButton from "../PrimaryButton";
import { GitArcStackIcon } from "../workbench-icons";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import { ThreadCheckpointCommitTargetAnchor } from "./ThreadCheckpointCommitPortalLayer";
import ThreadDisclosure from "./ThreadDisclosure";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Pure pending or pure committed lists read as one noun; mixed lists split commits from proposals. */
function formatProposalCounts(committed: number, proposed: number) {
  if (!committed) return plural(proposed, "commit proposal");
  if (!proposed) return plural(committed, "commit");
  return `${plural(committed, "commit")}, ${plural(proposed, "proposal")}`;
}

function readProposalsOpen(records: readonly WorkbenchClientStateRecord[]) {
  for (const record of records) {
    if (record.kind === "globalPreference" && record.preference.key === "threadGitArcProposalsOpen") {
      return record.preference.value;
    }
  }
  return true;
}

export default function ThreadGitArcProposalList({
  commitActions,
  proposals,
  running,
  stackLayers,
}: {
  commitActions: ThreadCheckpointCommitActions;
  proposals: ReadonlyArray<{ proposalId: string; status: GitArcProposalStatus }>;
  /** Running turns collapse by saved preference; stopped threads always show pending proposals. */
  running: boolean;
  /** Sealed layers, bottom first; their proposals render inside one disclosure per layer. */
  stackLayers: ReadonlyArray<{ layerId: string; proposalIds: readonly string[]; title: string }>;
}) {
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const canPersist = clientState.schemaVersion >= appStateReleases.threadGitArcProposalsOpen.version;
  const [unpersistedOpen, setUnpersistedOpen] = useState(true);
  const [committingAll, setCommittingAll] = useState(false);
  const sealedIds = new Set(stackLayers.flatMap(({ proposalIds }) => proposalIds));
  const layerGroups = stackLayers.flatMap((layer) => {
    const layerIds = new Set(layer.proposalIds);
    const layerProposals = proposals.filter(({ proposalId }) => layerIds.has(proposalId));
    return layerProposals.length ? [{ layer, proposals: layerProposals }] : [];
  });
  const unsealedProposals = proposals.filter(({ proposalId }) => !sealedIds.has(proposalId));
  // Commit all walks the stack bottom-up, then unsealed work built on top of it.
  const proposedIds = [...layerGroups.flatMap(({ proposals: layerProposals }) => layerProposals), ...unsealedProposals]
    .filter(({ status }) => status === "proposed").map(({ proposalId }) => proposalId);
  // Only pending work on a stopped thread demands attention; anything else follows the saved preference.
  const collapsible = running || !proposedIds.length;
  const open = !collapsible || (canPersist ? readProposalsOpen(clientState.records) : unpersistedOpen);
  const readSnapshot = () => commitActions.isReady(proposedIds);
  const commitAllReady = useSyncExternalStore(commitActions.subscribe, readSnapshot, readSnapshot);
  const pendingIdsOf = (group: (typeof layerGroups)[number]) => group.proposals
    .filter(({ status }) => status === "proposed").map(({ proposalId }) => proposalId);
  // Only the lowest layer with pending work can commit; higher layers wait on it.
  const lowestPendingGroup = layerGroups.find(group => pendingIdsOf(group).length);
  const lowestPendingLayerId = lowestPendingGroup?.layer.layerId ?? null;
  const readLayerSnapshot = () => commitActions.isReady(lowestPendingGroup ? pendingIdsOf(lowestPendingGroup) : []);
  const commitLayerReady = useSyncExternalStore(commitActions.subscribe, readLayerSnapshot, readLayerSnapshot);

  const setOpen = (next: boolean) => {
    if (next === open) return;
    if (!canPersist) {
      setUnpersistedOpen(next);
      return;
    }
    void clientStateController.put({
      kind: "globalPreference",
      preference: { key: "threadGitArcProposalsOpen", value: next },
    }).catch((error) => {
      console.error("Workbench proposal disclosure persistence failed.", error);
    });
  };
  /** One commit run at a time, whether started from the header or a layer. */
  const commitInOrder = async (ids: readonly string[]) => {
    if (committingAll) return;
    setCommittingAll(true);
    try {
      // Each card surfaces its own failure; the run simply stops there.
      await commitActions.commitAll(ids);
    } finally {
      setCommittingAll(false);
    }
  };

  const summary = (
    <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span>{formatProposalCounts(proposals.length - proposedIds.length, proposedIds.length)}</span>
      {open && (proposedIds.length > 1 || committingAll) ? (
        <span className="inline-flex min-w-0 items-center justify-end" data-thread-summary-action="true">
          <PrimaryButton
            className="!px-3 !py-1.5 !text-[0.76rem]"
            data-thread-git-arc-commit-all="true"
            disabled={committingAll || !commitAllReady}
            onClick={() => void commitInOrder(proposedIds)}
            pendingHalo={committingAll}
          >
            {committingAll ? "Committing…" : "Commit all"}
          </PrimaryButton>
        </span>
      ) : null}
    </span>
  );
  const anchor = (proposalId: string) => (
    <div
      className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
      data-thread-git-arc-proposal-separator="true"
      key={proposalId}
    >
      <ThreadCheckpointCommitTargetAnchor proposalId={proposalId} />
    </div>
  );
  const anchors = [
    ...layerGroups.map((group) => {
      const { layer, proposals: layerProposals } = group;
      const layerPendingIds = pendingIdsOf(group);
      const pending = layerPendingIds.length;
      const lowest = layer.layerId === lowestPendingLayerId;
      return (
        <ThreadDisclosure
          className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
          data-thread-git-arc-stack-layer={layer.layerId}
          // Sealed cards stay mounted so commit-all can walk the whole stack while layers are closed.
          keepMounted
          key={layer.layerId}
          leading={<GitArcStackIcon size={14} />}
          leadingLabel="stack layer"
          summary={(
            <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 truncate font-medium text-text">{layer.title}</span>
                <span className="text-fg/muted">{formatProposalCounts(layerProposals.length - pending, pending)}</span>
              </span>
              {pending ? (
                <span className="inline-flex min-w-0 items-center justify-end" data-thread-summary-action="true">
                  <PrimaryButton
                    className="!px-3 !py-1 !text-[0.74rem]"
                    data-thread-git-arc-commit-layer={layer.layerId}
                    disabled={committingAll || !lowest || !commitLayerReady}
                    onClick={() => void commitInOrder(layerPendingIds)}
                    pendingHalo={committingAll && lowest}
                    title={lowest ? undefined : "Commit lower layers first."}
                  >
                    {committingAll && lowest ? "Committing…" : "Commit layer"}
                  </PrimaryButton>
                </span>
              ) : null}
            </span>
          )}
          summaryClassName="px-3 py-2 text-[0.76em] leading-[1.45]"
        >
          {layerProposals.map(({ proposalId }) => anchor(proposalId))}
        </ThreadDisclosure>
      );
    }),
    ...unsealedProposals.map(({ proposalId }) => anchor(proposalId)),
  ];

  return collapsible ? (
    <ThreadDisclosure
      // Anchors stay mounted while closed so relocated controllers keep their edits.
      keepMounted
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
      summary={summary}
      summaryClassName="px-3 py-2 text-[0.76em] leading-[1.45]"
    >
      {anchors}
    </ThreadDisclosure>
  ) : (
    <div>
      <div className="flex min-w-0 items-center px-3 py-2 text-[0.76em] leading-[1.45] text-fg/muted">{summary}</div>
      {anchors}
    </div>
  );
}
