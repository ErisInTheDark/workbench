/*
 * Exports:
 * - countThreadAcceptedGitCommits: live committed proposals plus recorded history the live arc does not already show.
 * - default ThreadGitArcProposalList: the thread's interactive proposal cards and durable accepted-commit rows (whose refs load when the list shows them and details when their age group first mounts, and which load their source proposal for amend once opened); pending work sits in a recessed card under a persisted commit-all header (a lone proposal is its own persisted disclosure) with tall stacks folded past the committable layer, accepted history under one group per commit age unless a single age is the whole panel.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import {
  getWorkbenchLiveCommittedGitCommitKeys,
  workbenchThreadGitCommitKey,
  type WorkbenchGitArcLifecycleState,
  type WorkbenchGitArcProposalState,
  type WorkbenchHarnessId,
  type WorkbenchThreadGitCommitHistory,
  type WorkbenchThreadGitCommitRef,
} from "workbench-shared/workbench/thread/thread-state";
import { threadGitCommitHistoryFor, type ThreadGitCommitDetail } from "../../../workbench/thread/ThreadGitCommitHistory";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import PrimaryButton from "../../ui/PrimaryButton";
import { CheckCheckIcon, EllipsisIcon, GitArcProposalIcon, GitArcStackIcon } from "../workbench-icons";
import { useWorkbenchClientState, useWorkbenchClientStateController } from "../workbench-client-state-context";
import { ThreadCheckpointCommitActionsContext, type ThreadCheckpointStoredProposal } from "./ThreadCheckpointCommitActions";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";
import Disclosure from "../../ui/Disclosure";
import type { ThreadCommitDisclosure } from "./ThreadCheckpointCommitCard";
import ThreadGitArcCommitGroup, { plural, threadGitArcCommitRowClassName } from "./ThreadGitArcCommitGroup";
import { groupCommitsByAge } from "./thread-git-commit-age";

/** Stack layers shown from the committable one up before the rest fold into one row. */
const VISIBLE_LAYER_COUNT = 3;

/** Pure pending or pure committed lists read as one noun; mixed lists split commits from proposals. */
function formatProposalCounts(committed: number, proposed: number) {
  if (!committed) return plural(proposed, "commit proposal");
  if (!proposed) return plural(committed, "commit");
  return `${plural(committed, "commit")}, ${plural(proposed, "proposal")}`;
}

/** Live committed proposals plus recorded history the live arc does not already show. */
export function countThreadAcceptedGitCommits(
  proposals: readonly WorkbenchGitArcProposalState[],
  history: WorkbenchThreadGitCommitHistory | undefined,
) {
  return proposals.filter(({ status }) => status === "committed").length + (history?.count ?? 0);
}

/** Recorded commits the live arc does not already show, in acceptance order. */
function getHistoricalCommits(proposals: readonly WorkbenchGitArcProposalState[], refs: readonly WorkbenchThreadGitCommitRef[]) {
  const live = getWorkbenchLiveCommittedGitCommitKeys(proposals);
  return refs.filter(commit => !live.has(workbenchThreadGitCommitKey(commit)))
    .slice().sort((left, right) => left.historyIndex - right.historyIndex
      || left.rootId.localeCompare(right.rootId)
      || left.commitSha.localeCompare(right.commitSha));
}

/** The whole recorded history loads once a view shows it, and again only when the entry's revision moves. */
function useAcceptedCommitRefs(threadId: string, history: WorkbenchThreadGitCommitHistory | undefined) {
  const store = threadGitCommitHistoryFor(useWorkbenchDaemonClient());
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const revision = history?.count ? history.revision : null;
  useEffect(() => {
    if (revision) void store.loadRefs(threadId, revision);
  }, [revision, store, threadId]);
  return revision ? { refs: store.getRefs(threadId), retry: () => void store.loadRefs(threadId, revision) } : null;
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
 * proposal come from the observed summaries; a card that did load (and may hold edits) still wins.
 */
function useObservedProposalCommits(commitActions: ThreadCheckpointCommitActions, pending: readonly WorkbenchGitArcProposalState[]) {
  const [failure, setFailure] = useState<string | null>(null);
  const stored = pending.flatMap(({ proposalId, status, summary }): ThreadCheckpointStoredProposal[] => summary ? [{
    description: summary.description,
    hasChanges: summary.changes === null || summary.changes.length > 0,
    mode: summary.mode,
    proposalId,
    status,
    title: summary.title,
  }] : []);
  // Rows are re-observed on every lifecycle change; only their commit facts decide whether the stored tier changes.
  const storedKey = stored.map(({ description, hasChanges, mode, proposalId, title }) => (
    [proposalId, mode, hasChanges ? "1" : "0", title, description].join("\u0001")
  )).join("\0");
  const latestStored = useRef(stored);
  useEffect(() => { latestStored.current = stored; });
  useEffect(() => {
    if (!storedKey) return;
    return commitActions.setStored(latestStored.current, ({ title }, outcome) => {
      setFailure("error" in outcome
        ? `${title}: ${(outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 300)}`
        : null);
    });
  }, [commitActions, storedKey]);
  return failure;
}

type AcceptedEntry = { committedAt?: string } & ({ commit: WorkbenchThreadGitCommitRef } | { row: () => ReactNode });

/**
 * Mounts only once its age group opens (or when it is the whole panel), so commit details load as rows become visible.
 * Commits whose details failed collapse into one notice whose retry reads them again; the store logs the cause.
 */
function AcceptedCommitRows({ entries, renderCommit, threadId }: {
  entries: readonly AcceptedEntry[];
  renderCommit: (commit: WorkbenchThreadGitCommitRef, detail: Exclude<ThreadGitCommitDetail, { status: "failed" }>) => ReactNode;
  threadId: string;
}) {
  const history = threadGitCommitHistoryFor(useWorkbenchDaemonClient());
  useSyncExternalStore(history.subscribe, history.getVersion, history.getVersion);
  const commits = entries.flatMap(entry => "commit" in entry ? [entry.commit] : []);
  const commitsKey = commits.map(workbenchThreadGitCommitKey).join("\n");
  const latestCommits = useRef(commits);
  useEffect(() => { latestCommits.current = commits; });
  useEffect(() => {
    if (commitsKey) void history.load(threadId, latestCommits.current);
  }, [commitsKey, history, threadId]);
  const failed = commits.filter(commit => history.get(threadId, commit).status === "failed");
  return (
    <>
      {entries.map(entry => {
        if (!("commit" in entry)) return entry.row();
        const detail = history.get(threadId, entry.commit);
        return detail.status === "failed" ? null : renderCommit(entry.commit, detail);
      })}
      {failed.length ? (
        <div className={`${threadGitArcCommitRowClassName} flex items-center gap-3 py-2 text-[0.8em] leading-[1.5]`} role="alert">
          <span className="min-w-0 flex-1 text-danger">{`Details for ${plural(failed.length, "commit")} couldn't load.`}</span>
          <button
            className="shrink-0 cursor-pointer text-fg/muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
            data-thread-git-commit-retry="true"
            onClick={() => void history.load(threadId, failed)}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function ThreadGitArcProposalList({
  acceptance,
  commitActions,
  cwd,
  harness,
  history,
  proposals,
  stackLayers,
  standalone = false,
  threadId,
}: {
  /** The observed running batched acceptance, if any. */
  acceptance: WorkbenchGitArcLifecycleState["acceptance"] | null;
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  history?: WorkbenchThreadGitCommitHistory;
  threadId: string;
  proposals: readonly WorkbenchGitArcProposalState[];
  /** Sealed layers, bottom first; their proposals render inside one disclosure per layer. */
  stackLayers: ReadonlyArray<{ layerId: string; proposalIds: readonly string[]; title: string }>;
  /** Nothing else shares the panel, so accepted history alone may drop its group row. */
  standalone?: boolean;
}) {
  const daemon = useWorkbenchDaemonClient();
  const clientStateController = useWorkbenchClientStateController();
  const canPersist = useWorkbenchClientState(state => state.schemaVersion >= appStateReleases.threadGitArcProposalsOpen.version);
  const storedOpen = useWorkbenchClientState(state => readProposalsOpen(state.records));
  const [unpersistedOpen, setUnpersistedOpen] = useState(true);
  const [committingAll, setCommittingAll] = useState(false);
  const [showAllLayers, setShowAllLayers] = useState(false);
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
  const acceptedProposals = unsealedProposals.filter(({ status }) => status === "committed");
  const acceptedCount = countThreadAcceptedGitCommits(proposals, history);
  const recorded = useAcceptedCommitRefs(threadId, history);
  const refs = recorded?.refs.status === "ready" ? recorded.refs.refs : [];
  const historicalCommits = getHistoricalCommits(proposals, refs);
  const trailingProposals = acceptedProposals.length
    ? unsealedProposals.filter(({ status }) => status !== "committed")
    : unsealedProposals;
  // Only the lowest layer with pending work can commit; higher layers wait on it.
  const lowestPendingGroup = layerGroups.find(({ pendingIds }) => pendingIds.length);
  const open = canPersist ? storedOpen : unpersistedOpen;
  const storedFailure = useObservedProposalCommits(commitActions, proposals.filter(({ status }) => status === "proposed"));
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

  // A lone pending proposal is the whole list, so its own card is the persisted disclosure instead of a header.
  const loneId = proposals.length === 1 && proposedIds.length === 1 && !history?.count && !layerGroups.length
    ? proposedIds[0]!
    : null;
  const commitAllAction = showCommitAll || committing ? (
    <span className="ml-auto inline-flex min-w-0 items-center justify-end" data-thread-summary-action="true">
      <PrimaryButton
        data-thread-git-arc-commit-all="true"
        shape="compact"
        disabled={committing || !commitAllReady}
        onClick={() => void commitInOrder(proposedIds)}
        pendingHalo={committing}
      >
        {remaining ? `Committing… ${remaining} left` : committing ? "Committing…" : loneId ? "Commit" : "Commit all"}
      </PrimaryButton>
    </span>
  ) : null;
  const summary = (
    <span className="flex min-w-0 w-full flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 grow basis-[16rem] items-center gap-2">
        {proposedIds.length ? <GitArcProposalIcon className="shrink-0" size={16} /> : <CheckCheckIcon className="shrink-0" size={16} />}
        {formatProposalCounts(acceptedCount, proposedIds.length)}
      </span>
      {commitAllAction}
    </span>
  );
  const anchor = (proposalId: string, disclosure?: ThreadCommitDisclosure) => (
    <div
      className={`scroll-mt-6 ${threadGitArcCommitRowClassName}`}
      data-thread-git-arc-proposal={proposalId}
      data-thread-git-arc-proposal-separator="true"
      key={proposalId}
    >
      <ThreadCheckpointCommitController
        cwd={cwd}
        disclosure={disclosure}
        harness={harness}
        intent={null}
        proposalId={proposalId}
        sourceItemId={`lifecycle-proposal:${proposalId}`}
        threadId={threadId}
      />
    </div>
  );
  // A permanent commit opens onto its source proposal, which loads (and offers amend) only once opened.
  const historyRow = (ref: WorkbenchThreadGitCommitRef, detail: Exclude<ThreadGitCommitDetail, { status: "failed" }>) => {
    const key = workbenchThreadGitCommitKey(ref);
    if (detail.status === "loading") return (
      <div className={threadGitArcCommitRowClassName} data-thread-git-commit={ref.commitSha} key={key}>
        <div aria-hidden="true" className="flex items-center gap-2 py-2">
          <span className="size-3 shrink-0 rounded workbench-skeleton" />
          <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
        </div>
      </div>
    );
    const commit = detail.commit;
    return (
      <div
        className={threadGitArcCommitRowClassName}
        data-thread-git-arc-proposal={commit.sourceProposalId}
        data-thread-git-commit={commit.commitSha}
        key={key}
      >
        <ThreadCheckpointCommitController
          cwd={cwd}
          harness={harness}
          intent={null}
          proposalId={commit.sourceProposalId}
          sourceItemId={`durable-commit:${commit.rootId}:${commit.sourceProposalId}`}
          summary={{
            changes: null,
            ...(commit.committedAt ? { committedAt: commit.committedAt } : {}),
            committedSha: commit.commitSha,
            description: commit.description,
            mode: "commit",
            title: commit.title,
          }}
          threadId={threadId}
        />
      </div>
    );
  };
  // A live summary from the startup cache has no time yet; its permanent row may already know it.
  const recordedTimes = new Map(refs.map(commit => [workbenchThreadGitCommitKey(commit), commit.committedAt]));
  // Chronological: durable history in acceptance order, then this arc's own accepted proposals.
  const acceptedEntries: AcceptedEntry[] = [
    ...historicalCommits.map(commit => ({ committedAt: commit.committedAt, commit })),
    ...acceptedProposals.map(({ proposalId, rootId, summary }) => ({
      committedAt: summary?.committedAt ?? recordedTimes.get(`${rootId}\0${summary?.committedSha}`),
      row: () => anchor(proposalId),
    })),
  ];
  const acceptedRows = (entries: readonly AcceptedEntry[], key?: string) => (
    <AcceptedCommitRows entries={entries} key={key} renderCommit={historyRow} threadId={threadId} />
  );
  const ageGroups = groupCommitsByAge(acceptedEntries, ({ committedAt }) => committedAt, new Date());
  // Accepted history alone is the whole panel, so a single age group needs no group row of its own.
  const flattenAccepted = standalone && ageGroups.length === 1
    && !proposedIds.length && !layerGroups.length && !trailingProposals.length;
  const layerRows = layerGroups.map((group) => {
    const { layer, pendingIds: layerPendingIds, proposals: layerProposals } = group;
    const pending = layerPendingIds.length;
    const committed = layerProposals.length - pending;
    return (
      <ThreadGitArcCommitGroup
        // Only the lowest pending layer can commit, so higher layers carry no button to disable.
        action={group === lowestPendingGroup ? (
          <span className="inline-flex min-w-0 items-center justify-end" data-thread-summary-action="true">
            <PrimaryButton
              className="!px-3 !py-1 !text-[0.74rem]"
              data-thread-git-arc-commit-layer={layer.layerId}
              disabled={committing || !commitLayerReady}
              onClick={() => void commitInOrder(layerPendingIds)}
              pendingHalo={committing}
            >
              {committing ? "Committing…" : "Commit layer"}
            </PrimaryButton>
          </span>
        ) : null}
        // The list header already says these are commit proposals.
        count={committed ? formatProposalCounts(committed, pending) : plural(pending, "proposal")}
        data-thread-git-arc-stack-layer={layer.layerId}
        icon={<GitArcStackIcon size={14} />}
        iconLabel="stack layer"
        // Sealed cards stay mounted so commit-all can walk the whole stack while layers are closed.
        keepMounted
        key={layer.layerId}
        title={layer.title}
      >
        {layerProposals.map(({ proposalId }) => anchor(proposalId))}
      </ThreadGitArcCommitGroup>
    );
  });
  // Tall stacks show the committable layer and a few above it; folding a lone layer would save nothing.
  const visibleLayerEnd = (lowestPendingGroup ? layerGroups.indexOf(lowestPendingGroup) : 0) + VISIBLE_LAYER_COUNT;
  const foldedLayers = layerRows.length - visibleLayerEnd > 1 ? layerRows.slice(visibleLayerEnd) : [];
  // Until the recorded history arrives its groups cannot be formed; the header already counts it.
  const pendingHistory = !recorded || recorded.refs.status === "ready" ? null : recorded.refs.status === "failed" ? (
    <div className={`${threadGitArcCommitRowClassName} flex items-center gap-3 py-2 text-[0.8em] leading-[1.5]`} key="history-failed" role="alert">
      <span className="min-w-0 flex-1 text-danger">Accepted commits couldn&apos;t load.</span>
      <button
        className="shrink-0 cursor-pointer text-fg/muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
        data-thread-git-commit-retry="true"
        onClick={recorded.retry}
        type="button"
      >
        Retry
      </button>
    </div>
  ) : (
    <div className={threadGitArcCommitRowClassName} data-thread-git-commit-history-loading="true" key="history-loading">
      <div aria-hidden="true" className="flex items-center gap-2 py-2">
        <span className="size-3 shrink-0 rounded workbench-skeleton" />
        <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
      </div>
    </div>
  );
  const anchors = [
    ...(pendingHistory ? [pendingHistory] : []),
    ...(flattenAccepted ? [acceptedRows(ageGroups[0]!.entries, "accepted")] : ageGroups.map(({ bucket, entries, title }) => (
      <ThreadGitArcCommitGroup
        count={plural(entries.length, "commit")}
        data-thread-git-arc-accepted-group={bucket}
        icon={<CheckCheckIcon size={14} />}
        iconLabel="accepted commits"
        key={`accepted:${bucket}`}
        title={title}
      >
        {acceptedRows(entries)}
      </ThreadGitArcCommitGroup>
    ))),
    ...(foldedLayers.length ? layerRows.slice(0, visibleLayerEnd) : layerRows),
    ...(foldedLayers.length ? [
      showAllLayers ? null : (
        <button
          className={`
            flex w-full cursor-pointer items-center gap-2 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2
            text-left text-[0.76em] leading-[1.45] text-fg/muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none
          `}
          data-thread-git-arc-more-layers="true"
          key="more-layers"
          onClick={() => setShowAllLayers(true)}
          type="button"
        >
          {/* Same chevron slot and icon box as a layer row, so the fold lines up under the layers. */}
          <EllipsisIcon aria-hidden="true" className="shrink-0" size={18} />
          <span aria-hidden="true" className="flex size-[1.1rem] shrink-0 items-center justify-center">
            <GitArcStackIcon size={14} />
          </span>
          {`${foldedLayers.length} more layers`}
        </button>
      ),
      // Folded layers stay mounted for the same reason closed layers do: commit-all walks the whole stack.
      <div className={showAllLayers ? "contents" : "hidden"} data-thread-git-arc-folded-layers="true" key="folded-layers">
        {foldedLayers}
      </div>,
    ] : []),
    ...trailingProposals.map(({ proposalId }) => anchor(proposalId)),
  ];

  // Commits started from bulk summaries have no loaded card to show their failure, so the list shows it.
  const failureRow = storedFailure ? (
    <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 text-[0.8em] leading-[1.5] text-danger" role="alert">
      {storedFailure}
    </p>
  ) : null;

  return (
    <ThreadCheckpointCommitActionsContext.Provider value={commitActions}>
      {/* The header exists to commit or hide pending work; with none, the panel button already discloses the rest. */}
      {loneId ? (
        <div className="[&>*:first-child]:border-t-0">
          {anchor(loneId, { closedAction: commitAllAction, onOpenChange: setOpen, open })}
          {failureRow}
        </div>
      ) : !proposedIds.length ? (
        <div className="py-1 [&>*:first-child]:border-t-0">
          {failureRow}
          {anchors}
        </div>
      ) : <Disclosure
        // The same recessed card a group gives its own rows: hairlines between rows, none on top.
        contentClassName="mx-3 mb-2 overflow-hidden rounded-[0.65rem] bg-fg/4 [&>*:first-child]:border-t-0"
        // Cards stay mounted while closed so they keep their edits and commit-all can reach them.
        keepMounted
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
        summary={summary}
        summaryClassName="px-3 py-2 text-[0.76em] leading-[1.45]"
      >
        {open ? failureRow : null}
        {anchors}
      </Disclosure>}
      {loneId || !proposedIds.length || open ? null : failureRow}
    </ThreadCheckpointCommitActionsContext.Provider>
  );
}
