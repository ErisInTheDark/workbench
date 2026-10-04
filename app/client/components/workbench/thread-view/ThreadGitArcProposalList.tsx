/*
 * Exports:
 * - default ThreadGitArcProposalList: hoisted proposal anchors under a header that collapses unless a stopped thread has pending proposals, and offers commit all.
 */
"use client";

import { useState, useSyncExternalStore } from "react";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { GitArcProposalStatus } from "workbench-shared/workbench/git/git-arc-storage";
import PrimaryButton from "../PrimaryButton";
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
}: {
  commitActions: ThreadCheckpointCommitActions;
  proposals: ReadonlyArray<{ proposalId: string; status: GitArcProposalStatus }>;
  /** Running turns collapse by saved preference; stopped threads always show pending proposals. */
  running: boolean;
}) {
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const canPersist = clientState.schemaVersion >= appStateReleases.threadGitArcProposalsOpen.version;
  const [unpersistedOpen, setUnpersistedOpen] = useState(true);
  const [committingAll, setCommittingAll] = useState(false);
  const proposedIds = proposals.filter(({ status }) => status === "proposed").map(({ proposalId }) => proposalId);
  // Only pending work on a stopped thread demands attention; anything else follows the saved preference.
  const collapsible = running || !proposedIds.length;
  const open = !collapsible || (canPersist ? readProposalsOpen(clientState.records) : unpersistedOpen);
  const readSnapshot = () => commitActions.isReady(proposedIds);
  const commitAllReady = useSyncExternalStore(commitActions.subscribe, readSnapshot, readSnapshot);

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
  const commitAll = async () => {
    if (committingAll) return;
    setCommittingAll(true);
    try {
      // Each card surfaces its own failure; the run simply stops there.
      await commitActions.commitAll(proposedIds);
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
            onClick={() => void commitAll()}
            pendingHalo={committingAll}
          >
            {committingAll ? "Committing…" : "Commit all"}
          </PrimaryButton>
        </span>
      ) : null}
    </span>
  );
  const anchors = proposals.map(({ proposalId }) => (
    <div
      className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
      data-thread-git-arc-proposal-separator="true"
      key={proposalId}
    >
      <ThreadCheckpointCommitTargetAnchor proposalId={proposalId} />
    </div>
  ));

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
