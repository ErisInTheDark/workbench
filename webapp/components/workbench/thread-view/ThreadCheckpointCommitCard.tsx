/*
 * Exports:
 * - CheckpointCommitCardState: describe pending enrichment, error, and loaded proposal card states. Keywords: checkpoint, commit, card, state.
 * - default ThreadCheckpointCommitCard: render one always-visible checkpoint commit proposal card. Keywords: checkpoint, commit, proposal, changeset, actions.
 */
"use client";

import type { KeyboardEvent } from "react";

import type { GitCheckpointProposal } from "../../../lib/workbench/git/checkpoint-contracts";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import PrimaryButton from "../PrimaryButton";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { CheckIcon } from "../workbench-icons";
import PlaintextEditable from "./PlaintextEditable";
import GitArcIcon from "./GitArcIcon";
import ThreadDisclosure from "./ThreadDisclosure";
import {
  ThreadFileChangeList,
  ThreadFileChangeTotals,
} from "./ThreadFileChangeItem";

export type CheckpointCommitCardState =
  | { error: string; retryable: boolean; status: "error" }
  | { proposal: GitCheckpointProposal; status: "loaded" }
  | { status: "pending" };

export default function ThreadCheckpointCommitCard({
  committing,
  description,
  embedded = false,
  includeNewer,
  onCommit,
  onDescriptionChange,
  onIncludeNewerChange,
  onRetry,
  onTitleChange,
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  sourceItemId,
  state,
  title,
  workspaceRoots,
}: {
  committing: boolean;
  description: string;
  embedded?: boolean;
  includeNewer: boolean;
  onCommit: () => void;
  onDescriptionChange: (value: string) => void;
  onIncludeNewerChange: (value: boolean) => void;
  onRetry: () => void;
  onTitleChange: (value: string) => void;
  paths: string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  sourceItemId: string;
  state: CheckpointCommitCardState;
  title: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const proposal = state.status === "loaded" ? state.proposal : null;
  const terminal = proposal ? proposal.status !== "proposed" : false;
  const additions = proposal?.changes.reduce((total, change) => total + change.additions, 0) ?? 0;
  const deletions = proposal?.changes.reduce((total, change) => total + change.deletions, 0) ?? 0;
  const fileCount = proposal?.changes.length ?? paths.length;
  const changeSummary = proposal || paths.length
    ? `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
    : "Arc changes";
  const canCommit = proposal?.status === "proposed" && !committing && Boolean(title.trim());
  const commitFromEditable = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "Enter"
      || !event.ctrlKey
      || event.altKey
      || event.metaKey
      || event.shiftKey
      || event.nativeEvent.isComposing
      || !canCommit
    ) {
      return;
    }

    event.preventDefault();
    onCommit();
  };

  return (
    <article
      aria-label="Checkpoint commit proposal"
      className={embedded
        ? "w-full px-3 py-2.5"
        : "my-2 w-full rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-3 py-2.5"}
      data-thread-checkpoint-card="true"
      data-thread-checkpoint-card-embedded={embedded ? "true" : undefined}
    >
      <div className="flex min-w-0 gap-2" data-thread-checkpoint-card-content="true">
        <span className="mt-1 inline-flex size-5 shrink-0 items-center justify-center text-muted" aria-hidden="true">
          <GitArcIcon action="propose" className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <PlaintextEditable
            ariaLabel="Commit title"
            className="min-h-6 w-full bg-transparent px-0 py-0.5 text-[0.94em] font-medium outline-none data-[empty=true]:before:text-muted data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent"
            onChange={onTitleChange}
            onKeyDown={commitFromEditable}
            placeholder="Commit title"
            readOnly={terminal}
            value={title}
          />
          {!terminal || description.trim() ? (
            <PlaintextEditable
              ariaLabel="Commit description"
              className="min-h-7 w-full whitespace-pre-wrap bg-transparent px-0 py-0.5 text-[0.8em] leading-5 text-muted outline-none data-[empty=true]:before:text-[color:color-mix(in_srgb,var(--text)_32%,transparent)] data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent focus:text-text"
              onChange={onDescriptionChange}
              onKeyDown={commitFromEditable}
              placeholder="Optional description"
              readOnly={terminal}
              value={description}
            />
          ) : null}
        </div>
      </div>

      {state.status === "error" ? (
        <p className="m-0 mt-1 text-[0.78em] text-[color:var(--danger)]" data-thread-checkpoint-card-error="true">{state.error}</p>
      ) : null}

      <div data-thread-checkpoint-card-changes="true">
        <ThreadDisclosure
          className="mt-1.5 py-0.5"
          contentClassName="mt-1 rounded-[0.65rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-2"
          summary={(
            <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="inline-flex min-w-0 items-baseline gap-2">
                <span>{changeSummary}</span>
                {proposal ? <ThreadFileChangeTotals additions={additions} deletions={deletions} /> : null}
              </span>
              <span
                className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2"
                data-thread-checkpoint-card-actions="true"
                data-thread-summary-action="true"
              >
                {proposal?.status === "proposed" && proposal.includeNewerAvailable ? (
                  <WorkbenchCheckbox
                    checked={includeNewer}
                    label="Include newer changes"
                    onChange={onIncludeNewerChange}
                  />
                ) : null}
                {proposal?.status === "committed" ? (
                  <span className="inline-flex items-center gap-2 text-[0.78em] text-muted">
                    <CheckIcon className="size-4 text-[color:var(--success)]" />
                    <span>Committed</span>
                    {proposal.committedSha ? <span className="font-mono text-text">{proposal.committedSha.slice(0, 8)}</span> : null}
                  </span>
                ) : proposal?.status === "superseded" ? (
                  <span className="text-[0.78em] text-muted">Superseded</span>
                ) : proposal?.status === "unavailable" ? (
                  <span className="text-[0.78em] text-[color:var(--danger)]">
                    {proposal.unavailableReason || "This proposal is no longer mechanically available."}
                  </span>
                ) : state.status === "error" ? (
                  state.retryable ? (
                    <button type="button" className="rounded-full px-2.5 py-1 text-[0.78em] text-muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text" onClick={onRetry}>
                      Try again
                    </button>
                  ) : <span className="text-[0.78em] text-[color:var(--danger)]">Unavailable</span>
                ) : (
                  <PrimaryButton className="!px-3 !py-1.5 !text-[0.78rem]" disabled={!canCommit} onClick={onCommit} pendingHalo={committing}>
                    {committing ? "Committing..." : "Commit"}
                  </PrimaryButton>
                )}
              </span>
            </span>
          )}
          summaryClassName="text-[0.82em] leading-[1.5] text-muted"
        >
          {proposal ? (
            <ThreadFileChangeList
              changes={proposal.changes.map((change, index) => ({
                change: {
                  diff: change.diff,
                  kind: change.kind.type === "update"
                    ? { move_path: change.kind.move_path ?? null, type: "update" as const }
                    : change.kind,
                  path: change.path,
                },
                sourceChangeIndex: index,
                sourceItemId,
              }))}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          ) : paths.length ? (
            <ThreadFileChangeList
              changes={paths.map((path, index) => ({
                change: {
                  diff: "",
                  kind: { move_path: null, type: "update" as const },
                  path,
                },
                detailsAvailable: false,
                presentationLabel: "Changed",
                sourceChangeIndex: index,
                sourceItemId,
              }))}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
          ) : (
            <p className="m-0 py-2 text-[0.78em] leading-[1.6] text-muted">
              The arc&apos;s claimed changes will appear here.
            </p>
          )}
        </ThreadDisclosure>
      </div>
    </article>
  );
}
