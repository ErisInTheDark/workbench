/*
 * Exports:
 * - default ThreadGitArcProposalList: hoisted proposal anchors, grouped into sealed stack layer disclosures, under a header that collapses (listing each landed commit's message and totals) unless a stopped thread has pending proposals, and offers stack-ordered commit all backed by one bulk proposal summary read.
 */
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import PrimaryButton from "../PrimaryButton";
import { GitArcStackIcon } from "../workbench-icons";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import { ThreadCheckpointCommitTargetAnchor } from "./ThreadCheckpointCommitPortalLayer";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";
import { useThreadGitArcProposalObservation } from "./ThreadGitArcObservationContext";

/** One landed commit's message and totals; demands its own observation because closed cards are hidden. */
function ClosedCommitRow({ proposalId }: { proposalId: string }) {
  const { observe, state } = useThreadGitArcProposalObservation(proposalId);
  useEffect(() => observe?.(proposalId), [observe, proposalId]);
  const proposal = state?.status === "loaded" ? state.proposal : null;
  return (
    <div
      className="flex min-w-0 items-baseline gap-2 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 text-[0.8em] leading-[1.5]"
      data-thread-git-arc-closed-proposal={proposalId}
    >
      <span className={`min-w-0 truncate ${proposal ? "text-text" : "text-fg/muted"}`}>
        {proposal?.title ?? (state?.status === "failed" ? "Commit unavailable" : "Loading commit...")}
      </span>
      {proposal ? <ThreadGitArcChangeTotals changes={proposal.changes} /> : null}
    </div>
  );
}

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

/**
 * Collapsed layers keep their cards mounted but never load them, so readiness and commits for every pending
 * proposal come from one diff-free bulk read; a card that did load (and may hold edits) still wins.
 */
function useStoredProposalCommits({ commitActions, cwd, harness, pendingIds, threadId }: {
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  pendingIds: readonly string[];
  threadId: string;
}) {
  const daemon = useWorkbenchDaemonClient();
  const [failure, setFailure] = useState<string | null>(null);
  const pendingKey = pendingIds.join("\0");
  useEffect(() => {
    const proposalIds = pendingKey ? pendingKey.split("\0") : [];
    if (!proposalIds.length) return;
    let disposed = false;
    let release = () => {};
    void (async () => {
      try {
        const { proposals } = await daemon.git.arc.proposal.summaries({ cwd, harness, proposalIds, threadId });
        if (disposed) return;
        release = commitActions.setStored(proposals, async ({ description, mode, proposalId, title }) => {
          try {
            await daemon.git.arc.proposal.commit({ cwd, description, harness, includeNewer: false, mode, proposalId, threadId, title });
            setFailure(null);
            return true;
          } catch (error) {
            setFailure(`${title}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
            return false;
          }
        });
      } catch (error) {
        // Daemons that predate bulk summaries leave readiness to each card's own load.
        if (!disposed) console.warn(`Proposal summaries unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      }
    })();
    return () => { disposed = true; release(); };
  }, [commitActions, cwd, daemon, harness, pendingKey, threadId]);
  return failure;
}

export default function ThreadGitArcProposalList({
  commitActions,
  cwd,
  harness,
  proposals,
  running,
  stackLayers,
  threadId,
}: {
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  threadId: string;
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
  const pendingIdsOf = (values: typeof proposals) => values
    .filter(({ status }) => status === "proposed").map(({ proposalId }) => proposalId);
  const sealedIds = new Set(stackLayers.flatMap(({ proposalIds }) => proposalIds));
  const layerGroups = stackLayers.flatMap((layer) => {
    const layerIds = new Set(layer.proposalIds);
    const layerProposals = proposals.filter(({ proposalId }) => layerIds.has(proposalId));
    return layerProposals.length ? [{ layer, pendingIds: pendingIdsOf(layerProposals), proposals: layerProposals }] : [];
  });
  const unsealedProposals = proposals.filter(({ proposalId }) => !sealedIds.has(proposalId));
  // Commit all walks the stack bottom-up, then unsealed work built on top of it.
  const proposedIds = [...layerGroups.flatMap(({ pendingIds }) => pendingIds), ...pendingIdsOf(unsealedProposals)];
  // Only the lowest layer with pending work can commit; higher layers wait on it.
  const lowestPendingGroup = layerGroups.find(({ pendingIds }) => pendingIds.length);
  // Only pending work on a stopped thread demands attention; anything else follows the saved preference.
  const collapsible = running || !proposedIds.length;
  const open = !collapsible || (canPersist ? readProposalsOpen(clientState.records) : unpersistedOpen);
  const storedFailure = useStoredProposalCommits({ commitActions, cwd, harness, pendingIds: open ? proposedIds : [], threadId });
  const readSnapshot = () => commitActions.isReady(proposedIds);
  const commitAllReady = useSyncExternalStore(commitActions.subscribe, readSnapshot, readSnapshot);
  const readLayerSnapshot = () => commitActions.isReady(lowestPendingGroup?.pendingIds ?? []);
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
      const { layer, pendingIds: layerPendingIds, proposals: layerProposals } = group;
      const pending = layerPendingIds.length;
      const lowest = group === lowestPendingGroup;
      return (
        <ThreadDisclosure
          className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
          // Open layers inset their proposals in a recessed well; the first card needs no line under the summary.
          contentClassName="mx-2 mb-2 overflow-hidden rounded-[0.65rem] bg-fg-alpha/4 [--fg-bg:color-mix(in_srgb,var(--text)_4%,var(--app-bg-solid))] [&>*:first-child]:border-t-0"
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

  // Commits started from bulk summaries have no loaded card to show their failure, so the list shows it.
  const failureRow = storedFailure ? (
    <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 text-[0.8em] leading-[1.5] text-danger" role="alert">
      {storedFailure}
    </p>
  ) : null;

  // Closed lists name landed commits only, in card order; pending proposals must not read as commits.
  const closedRows = [...layerGroups.flatMap(({ proposals: layerProposals }) => layerProposals), ...unsealedProposals]
    .filter(({ status }) => status === "committed")
    .map(({ proposalId }) => <ClosedCommitRow key={proposalId} proposalId={proposalId} />);

  return collapsible ? (
    <>
      <ThreadDisclosure
        // Anchors stay mounted while closed so relocated controllers keep their edits.
        keepMounted
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
        summary={summary}
        summaryClassName="px-3 py-2 text-[0.76em] leading-[1.45]"
      >
        {failureRow}
        {anchors}
      </ThreadDisclosure>
      {open ? null : closedRows}
    </>
  ) : (
    <div>
      <div className="flex min-w-0 items-center px-3 py-2 text-[0.76em] leading-[1.45] text-fg/muted">{summary}</div>
      {failureRow}
      {anchors}
    </div>
  );
}
