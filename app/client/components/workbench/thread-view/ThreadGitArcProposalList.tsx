/*
 * Exports:
 * - default ThreadGitArcProposalList: hoisted proposal anchors, grouped into sealed stack layer disclosures (behind a leading accepted-commits disclosure while work is pending), under a header that collapses (listing each landed commit's message and totals when nothing is pending) unless a stopped thread has pending proposals, and offers stack-ordered commit all (whether or not the header is collapsed) backed by one bulk proposal summary read.
 */
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchGitArcLifecycleState, WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import PrimaryButton from "../PrimaryButton";
import { CheckCheckIcon, GitArcStackIcon } from "../workbench-icons";
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

/** Group disclosures (stack layers, accepted commits) share one row line, summary and recessed well. */
const groupDisclosureProps = {
  className: "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]",
  // Open groups inset their proposals in a recessed well; the first card needs no line under the summary.
  contentClassName: "mx-2 mb-2 overflow-hidden rounded-[0.65rem] bg-fg/4 [&>*:first-child]:border-t-0",
  summaryClassName: "px-3 py-2 text-[0.76em] leading-[1.45]",
};

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
        release = commitActions.setStored(proposals, ({ title }, outcome) => {
          setFailure("error" in outcome
            ? `${title}: ${(outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 300)}`
            : null);
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
  acceptance,
  commitActions,
  cwd,
  harness,
  proposals,
  running,
  stackLayers,
  threadId,
}: {
  /** The observed running batched acceptance, if any. */
  acceptance: WorkbenchGitArcLifecycleState["acceptance"] | null;
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
  const daemon = useWorkbenchDaemonClient();
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
  // While work is pending, landed unsealed commits fold into one closed group ahead of it.
  const acceptedProposals = proposedIds.length ? unsealedProposals.filter(({ status }) => status === "committed") : [];
  const trailingProposals = acceptedProposals.length
    ? unsealedProposals.filter(({ status }) => status !== "committed")
    : unsealedProposals;
  // Only the lowest layer with pending work can commit; higher layers wait on it.
  const lowestPendingGroup = layerGroups.find(({ pendingIds }) => pendingIds.length);
  // Only pending work on a stopped thread demands attention; anything else follows the saved preference.
  const collapsible = running || !proposedIds.length;
  const open = !collapsible || (canPersist ? readProposalsOpen(clientState.records) : unpersistedOpen);
  const storedFailure = useStoredProposalCommits({ commitActions, cwd, harness, pendingIds: proposedIds, threadId });
  const readSnapshot = () => commitActions.isReady(proposedIds);
  const commitAllReady = useSyncExternalStore(commitActions.subscribe, readSnapshot, readSnapshot);
  const readLayerSnapshot = () => commitActions.isReady(lowestPendingGroup?.pendingIds ?? []);
  const commitLayerReady = useSyncExternalStore(commitActions.subscribe, readLayerSnapshot, readLayerSnapshot);

  // The observed acceptance covers every tab; the local flag covers this tab's request until the fact arrives.
  const remaining = acceptance ? acceptance.queuedIds.length + (acceptance.landingId ? 1 : 0) : 0;
  const committing = committingAll || Boolean(acceptance);
  // A collapsed header must commit for its hidden cards, so one pending proposal is enough there.
  const showCommitAll = proposedIds.length > (open ? 1 : 0);

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
    if (committing) return;
    setCommittingAll(true);
    try {
      // One batched acceptance; each card surfaces its own outcome and the run stops at the first failure.
      await commitActions.commitAll(ids, async entries => await daemon.git.arc.proposal.commitMany({ cwd, entries, harness, threadId }));
    } finally {
      setCommittingAll(false);
    }
  };

  const summary = (
    <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span>{formatProposalCounts(proposals.length - proposedIds.length, proposedIds.length)}</span>
      {showCommitAll || committing ? (
        <span className="inline-flex min-w-0 items-center justify-end" data-thread-summary-action="true">
          <PrimaryButton
            className="!px-3 !py-1.5 !text-[0.76rem]"
            data-thread-git-arc-commit-all="true"
            disabled={committing || !commitAllReady}
            onClick={() => void commitInOrder(proposedIds)}
            pendingHalo={committing}
          >
            {remaining ? `Committing… ${remaining} left` : committing ? "Committing…" : "Commit all"}
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
    // Unmounted anchors just park their cards, so a long accepted history costs nothing until opened.
    ...(acceptedProposals.length ? [(
      <ThreadDisclosure
        {...groupDisclosureProps}
        data-thread-git-arc-accepted-group="true"
        key="accepted"
        leading={<CheckCheckIcon size={14} />}
        leadingLabel="accepted commits"
        summary={(
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-text">Accepted</span>
            <span className="text-fg/muted">{plural(acceptedProposals.length, "commit")}</span>
          </span>
        )}
      >
        {acceptedProposals.map(({ proposalId }) => anchor(proposalId))}
      </ThreadDisclosure>
    )] : []),
    ...layerGroups.map((group) => {
      const { layer, pendingIds: layerPendingIds, proposals: layerProposals } = group;
      const pending = layerPendingIds.length;
      const lowest = group === lowestPendingGroup;
      return (
        <ThreadDisclosure
          {...groupDisclosureProps}
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
                    disabled={committing || !lowest || !commitLayerReady}
                    onClick={() => void commitInOrder(layerPendingIds)}
                    pendingHalo={committing && lowest}
                    title={lowest ? undefined : "Commit lower layers first."}
                  >
                    {committing && lowest ? "Committing…" : "Commit layer"}
                  </PrimaryButton>
                </span>
              ) : null}
            </span>
          )}
        >
          {layerProposals.map(({ proposalId }) => anchor(proposalId))}
        </ThreadDisclosure>
      );
    }),
    ...trailingProposals.map(({ proposalId }) => anchor(proposalId)),
  ];

  // Commits started from bulk summaries have no loaded card to show their failure, so the list shows it.
  const failureRow = storedFailure ? (
    <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 text-[0.8em] leading-[1.5] text-danger" role="alert">
      {storedFailure}
    </p>
  ) : null;

  // Closed lists name landed commits only, in card order; pending proposals must not read as commits, and while any
  // are pending the header count alone stands in for a possibly long accepted history.
  const closedRows = proposedIds.length ? [] : [...layerGroups.flatMap(({ proposals: layerProposals }) => layerProposals), ...unsealedProposals]
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
        {open ? failureRow : null}
        {anchors}
      </ThreadDisclosure>
      {open ? null : failureRow}
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
