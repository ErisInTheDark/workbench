/*
 * Exports:
 * - getThreadAcceptedGitHistory: dedupe permanent commits against actionable live committed proposals.
 * - default ThreadGitArcProposalList: the thread's interactive proposal cards and durable accepted-commit rows; pending work sits under a persisted commit-all header (a lone proposal is its own persisted disclosure), accepted history under its own group unless it is the whole panel.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type {
  WorkbenchGitArcLifecycleState,
  WorkbenchGitArcProposalState,
  WorkbenchHarnessId,
  WorkbenchThreadGitCommit,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import PrimaryButton from "../../ui/PrimaryButton";
import { CheckCheckIcon, GitArcProposalIcon, GitArcStackIcon } from "../workbench-icons";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { ThreadCheckpointCommitActionsContext, type ThreadCheckpointStoredProposal } from "./ThreadCheckpointCommitActions";
import type ThreadCheckpointCommitActions from "./ThreadCheckpointCommitActions";
import ThreadCheckpointCommitController from "./ThreadCheckpointCommitController";
import Disclosure from "../../ui/Disclosure";
import ThreadCheckpointCommitCard, { type ThreadCommitDisclosure } from "./ThreadCheckpointCommitCard";
import ThreadGitArcCommitGroup, { plural, threadGitArcCommitRowClassName } from "./ThreadGitArcCommitGroup";

/** Pure pending or pure committed lists read as one noun; mixed lists split commits from proposals. */
function formatProposalCounts(committed: number, proposed: number) {
  if (!committed) return plural(proposed, "commit proposal");
  if (!proposed) return plural(committed, "commit");
  return `${plural(committed, "commit")}, ${plural(proposed, "proposal")}`;
}

export function getThreadAcceptedGitHistory(
  proposals: readonly WorkbenchGitArcProposalState[],
  history: readonly WorkbenchThreadGitCommit[],
) {
  const liveCommitKeys = new Set(proposals.flatMap(({ rootId, status, summary }) => (
    status === "committed" && rootId && summary?.committedSha ? [`${rootId}\0${summary.committedSha}`] : []
  )));
  const historicalCommits = history
    .filter(({ commitSha, rootId }) => !liveCommitKeys.has(`${rootId}\0${commitSha}`))
    .slice().sort((left, right) => left.historyIndex - right.historyIndex
      || left.rootId.localeCompare(right.rootId)
      || left.sourceProposalId.localeCompare(right.sourceProposalId));
  return {
    acceptedCount: proposals.filter(({ status }) => status === "committed").length + historicalCommits.length,
    historicalCommits,
  };
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

export default function ThreadGitArcProposalList({
  acceptance,
  commitActions,
  cwd,
  harness,
  history = [],
  projectFilePaths,
  projectId,
  projectRootPath,
  proposals,
  stackLayers,
  standalone = false,
  threadId,
  workspaceRoots,
}: {
  /** The observed running batched acceptance, if any. */
  acceptance: WorkbenchGitArcLifecycleState["acceptance"] | null;
  commitActions: ThreadCheckpointCommitActions;
  cwd: string;
  harness: WorkbenchHarnessId;
  history?: readonly WorkbenchThreadGitCommit[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadId: string;
  proposals: readonly WorkbenchGitArcProposalState[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  /** Sealed layers, bottom first; their proposals render inside one disclosure per layer. */
  stackLayers: ReadonlyArray<{ layerId: string; proposalIds: readonly string[]; title: string }>;
  /** Nothing else shares the panel, so accepted history alone may drop its group row. */
  standalone?: boolean;
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
  const acceptedProposals = unsealedProposals.filter(({ status }) => status === "committed");
  const { acceptedCount, historicalCommits } = getThreadAcceptedGitHistory(proposals, history);
  const trailingProposals = acceptedProposals.length
    ? unsealedProposals.filter(({ status }) => status !== "committed")
    : unsealedProposals;
  // Only the lowest layer with pending work can commit; higher layers wait on it.
  const lowestPendingGroup = layerGroups.find(({ pendingIds }) => pendingIds.length);
  const open = canPersist ? readProposalsOpen(clientState.records) : unpersistedOpen;
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
  const loneId = proposals.length === 1 && proposedIds.length === 1 && !historicalCommits.length && !layerGroups.length
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
      <span className="flex min-w-0 grow basis-[16rem] items-center gap-1.5">
        {proposedIds.length ? <GitArcProposalIcon className="shrink-0" size={14} /> : <CheckCheckIcon className="shrink-0" size={14} />}
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
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        proposalId={proposalId}
        sourceItemId={`lifecycle-proposal:${proposalId}`}
        threadId={threadId}
        workspaceRoots={workspaceRoots}
      />
    </div>
  );
  const acceptedRows = [
    ...acceptedProposals.map(({ proposalId }) => anchor(proposalId)),
    ...historicalCommits.map(commit => (
      <div
        className={threadGitArcCommitRowClassName}
        data-thread-git-commit={commit.commitSha}
        key={`${commit.rootId}:${commit.sourceProposalId}`}
      >
        <ThreadCheckpointCommitCard
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          sourceItemId={`durable-commit:${commit.rootId}:${commit.sourceProposalId}`}
          state={{
            status: "summary",
            summary: {
              changes: null,
              committedSha: commit.commitSha,
              description: commit.description,
              title: commit.title,
            },
          }}
          workspaceRoots={workspaceRoots}
        />
      </div>
    )),
  ];
  // Accepted history alone is the whole panel, so its rows need no group of their own.
  const flattenAccepted = standalone && !proposedIds.length && !layerGroups.length && !trailingProposals.length;
  const anchors = [
    ...(flattenAccepted ? acceptedRows : acceptedRows.length ? [(
      <ThreadGitArcCommitGroup
        count={plural(acceptedRows.length, "commit")}
        data-thread-git-arc-accepted-group="true"
        icon={<CheckCheckIcon size={14} />}
        iconLabel="accepted commits"
        key="accepted"
        title="Accepted"
      >
        {acceptedRows}
      </ThreadGitArcCommitGroup>
    )] : []),
    ...layerGroups.map((group) => {
      const { layer, pendingIds: layerPendingIds, proposals: layerProposals } = group;
      const pending = layerPendingIds.length;
      const lowest = group === lowestPendingGroup;
      return (
        <ThreadGitArcCommitGroup
          action={pending ? (
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
          count={formatProposalCounts(layerProposals.length - pending, pending)}
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
    }),
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
