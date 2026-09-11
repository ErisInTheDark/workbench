/*
 * Exports:
 * - CheckpointCommitCardState: distinguish static previews, pending enrichment, failures, and loaded proposals.
 * - default ThreadCheckpointCommitCard: render proposal fields, loading shapes, and edit/commit controls in full or compact layouts.
 */
"use client";

import type { KeyboardEvent } from "react";

import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { createGitArcOperationRejected, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import PrimaryButton from "../PrimaryButton";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { AsteriskIcon, CheckIcon, PlusIcon } from "../workbench-icons";
import WorkbenchModeRow from "../WorkbenchModeRow";
import PlaintextEditable from "./PlaintextEditable";
import GitArcIcon from "./GitArcIcon";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import {
  ThreadFileChangeList,
  ThreadFileChangeTotals,
} from "./ThreadFileChangeItem";

export type CheckpointCommitCardState =
  | { error: string; failure?: GitArcFailure; retryable: boolean; status: "error" }
  | { proposal: GitCheckpointProposal; status: "loaded" }
  | { status: "pending" }
  | { status: "idle" };

export default function ThreadCheckpointCommitCard({
  commitMode,
  committing,
  description,
  embedded = false,
  freshCommitAvailable,
  includeNewer,
  messageAvailability,
  onCommit,
  onCommitModeChange,
  onDescriptionChange,
  onIncludeNewerChange,
  onRetry,
  onTitleChange,
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  presentation = "full",
  sourceItemId,
  state,
  title,
  workspaceRoots,
}: {
  commitMode: "amend" | "commit";
  committing: boolean;
  description: string;
  embedded?: boolean;
  freshCommitAvailable: boolean;
  includeNewer: boolean;
  messageAvailability?: { title: boolean; description: boolean };
  onCommit: () => void;
  onCommitModeChange: (value: "amend" | "commit") => void;
  onDescriptionChange: (value: string) => void;
  onIncludeNewerChange: (value: boolean) => void;
  onRetry: () => void;
  onTitleChange: (value: string) => void;
  paths: string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  presentation?: "compact-commit" | "compact-preview" | "full";
  sourceItemId: string;
  state: CheckpointCommitCardState;
  title: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const proposal = state.status === "loaded" ? state.proposal : null;
  const compact = presentation !== "full";
  const compactCanCommit = presentation === "compact-commit";
  const compactPreview = presentation === "compact-preview";
  const pending = state.status === "pending";
  const titlePending = pending && !(messageAvailability?.title ?? Boolean(title.trim()));
  const descriptionPending = pending && !(messageAvailability?.description ?? Boolean(description.trim()));
  const titleClassName = compact ? "min-h-5 text-[0.88em]" : "min-h-6 text-[0.94em]";
  const descriptionClassName = compact ? "min-h-5 text-[0.76em] leading-4" : "min-h-7 text-[0.8em] leading-5";
  const committedAmendable = proposal?.status === "committed" && proposal.amendability?.status === "available";
  const committedOutsideProposal = proposal?.status === "unavailable"
    && proposal.unavailableReasonCode === "committed-outside-proposal";
  const editable = !compactPreview && (!proposal || proposal.status === "proposed" || committedAmendable);
  const messageChanged = proposal?.status === "committed"
    && (title.trim() !== proposal.title.trim() || description.trim() !== proposal.description.trim());
  const displayedChanges = proposal?.mode === "amend" && commitMode === "commit" && proposal.freshChanges
    ? proposal.freshChanges
    : proposal?.changes ?? [];
  const additions = displayedChanges.reduce((total, change) => total + change.additions, 0);
  const deletions = displayedChanges.reduce((total, change) => total + change.deletions, 0);
  const fileCount = proposal ? displayedChanges.length : paths.length;
  const amendTargetMessage = proposal?.amendTargetMessage ?? null;
  const titleWillChange = commitMode === "amend"
    && amendTargetMessage !== null
    && title.trim() !== amendTargetMessage.title.trim();
  const descriptionWillChange = commitMode === "amend"
    && amendTargetMessage !== null
    && description.trim() !== amendTargetMessage.description.trim();
  const changeSummary = proposal || paths.length
    ? `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
    : "Arc changes";
  const canCommit = !committing
    && Boolean(title.trim())
    && Boolean(compactCanCommit
      ? proposal?.status === "proposed"
      : !compact && (proposal?.status === "proposed" || (committedAmendable && messageChanged)));
  const commitLabel = proposal?.status === "committed" || commitMode === "amend" ? "Amend" : "Commit";
  const failure = state.status === "error"
    ? state.failure ?? createGitArcOperationRejected("proposalCreate", state.error)
    : null;
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
      aria-busy={pending || undefined}
      className={compact
        ? "w-full px-0 py-0"
        : embedded
          ? "w-full px-3 py-2.5"
          : "my-2 w-full rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-3 py-2.5"}
      data-thread-checkpoint-card="true"
      data-thread-checkpoint-card-embedded={embedded ? "true" : undefined}
      data-thread-checkpoint-card-presentation={presentation}
    >
      <div className="flex min-w-0 gap-2" data-thread-checkpoint-card-content="true">
        <span className={compact
          ? "inline-flex h-6 w-5 shrink-0 items-center justify-center text-muted"
          : "mt-1 inline-flex size-5 shrink-0 items-center justify-center text-muted"}
          aria-hidden="true"
        >
          <GitArcIcon action="propose" className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-start gap-1">
            {titleWillChange ? (
              <span aria-label="Commit title differs from current commit" className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-muted" role="img">
                <AsteriskIcon className="size-3.5" />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              {titlePending ? (
                <div className={`${titleClassName} flex items-center py-0.5`} aria-hidden="true">
                  <span className="h-[1em] w-4/5 rounded workbench-skeleton" />
                </div>
              ) : (
                <PlaintextEditable
                  ariaLabel="Commit title"
                  className={`${titleClassName} w-full bg-transparent px-0 py-0.5 font-medium outline-none data-[empty=true]:before:text-muted data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent`}
                  onChange={onTitleChange}
                  onKeyDown={commitFromEditable}
                  placeholder="Commit title"
                  readOnly={!editable}
                  value={title}
                />
              )}
            </div>
          </div>
          {pending || editable || description.trim() ? (
            <div className="flex min-w-0 items-start gap-1">
              {descriptionWillChange ? (
                <span aria-label="Commit description differs from current commit" className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-muted" role="img">
                  <AsteriskIcon className="size-3.5" />
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                {descriptionPending ? (
                  <div className={`${descriptionClassName} flex items-center py-0.5`} aria-hidden="true">
                    <span className="h-[1em] w-3/5 rounded workbench-skeleton" />
                  </div>
                ) : (
                  <PlaintextEditable
                    ariaLabel="Commit description"
                    className={`${descriptionClassName} w-full whitespace-pre-wrap bg-transparent px-0 py-0.5 text-muted outline-none data-[empty=true]:before:text-[color:color-mix(in_srgb,var(--text)_32%,transparent)] data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent focus:text-text`}
                    onChange={onDescriptionChange}
                    onKeyDown={commitFromEditable}
                    placeholder="Optional description"
                    readOnly={!editable}
                    value={description}
                  />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {state.status === "error" ? (
        <div data-thread-checkpoint-card-error="true">
          <ThreadGitArcFailure
            failure={failure!}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
        </div>
      ) : null}

      <div data-thread-checkpoint-card-changes="true">
        {pending && !paths.length ? (
          <ThreadDisclosureStaticRow
            className="mt-1.5 py-0.5"
            marker={<span className="size-3 rounded workbench-skeleton" />}
            summaryClassName="text-[0.82em] leading-[1.5]"
            summary={(
              <span className="flex min-w-0 items-center justify-between gap-3" aria-hidden="true">
                <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
                {!compactPreview ? <span className="h-7 w-16 shrink-0 rounded-full workbench-skeleton" /> : null}
              </span>
            )}
          />
        ) : <ThreadDisclosure
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
                {(!compact || compactCanCommit) && proposal?.status === "proposed" && proposal.includeNewerAvailable ? (
                  <WorkbenchCheckbox
                    checked={includeNewer}
                    label="Include newer changes"
                    onChange={onIncludeNewerChange}
                  />
                ) : null}
                {(!compact || compactCanCommit) && proposal?.status === "proposed" && freshCommitAvailable ? (
                  <WorkbenchModeRow
                    ariaLabel="Commit mode"
                    disabled={committing}
                    onChange={onCommitModeChange}
                    options={[
                      {
                        ariaLabel: "Amend",
                        icon: <AsteriskIcon className="size-3.5" />,
                        label: "Amend",
                        value: "amend",
                      },
                      {
                        ariaLabel: "Commit fresh",
                        icon: <PlusIcon className="size-3.5" />,
                        label: "Commit fresh",
                        value: "commit",
                      },
                    ]}
                    value={commitMode}
                  />
                ) : null}
                {!compact && proposal?.status === "committed" && canCommit ? (
                  <PrimaryButton className="!px-3 !py-1.5 !text-[0.78rem]" data-thread-checkpoint-commit-action="true" disabled={!canCommit} onClick={onCommit} pendingHalo={committing}>
                    {committing ? "Amending..." : "Amend"}
                  </PrimaryButton>
                ) : proposal?.status === "committed" ? (
                  <span className="inline-flex items-center gap-2 text-[0.78em] text-muted">
                    <CheckIcon className="size-4 text-[color:var(--success)]" />
                    <span>Committed</span>
                    {proposal.committedSha ? <span className="font-mono text-text">{proposal.committedSha.slice(0, 8)}</span> : null}
                  </span>
                ) : proposal?.status === "superseded" ? (
                  <span className="text-[0.78em] text-muted">Superseded</span>
                ) : committedOutsideProposal ? (
                  <span
                    className="inline-flex items-center gap-2 text-[0.78em] text-muted"
                    data-thread-checkpoint-committed-outside-proposal="true"
                  >
                    <CheckIcon className="size-4 text-[color:var(--success)]" />
                    <span>Committed outside proposal</span>
                  </span>
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
                ) : pending ? (
                  !compactPreview ? <span className="h-7 w-16 rounded-full workbench-skeleton" aria-hidden="true" /> : null
                ) : !compact || compactCanCommit ? (
                  <PrimaryButton
                    className={`
                      !px-3 ${compact ? "!py-1" : "!py-1.5"}
                      !text-[0.78rem]
                    `}
                    data-thread-checkpoint-commit-action="true"
                    disabled={!canCommit}
                    onClick={onCommit}
                    pendingHalo={committing}
                  >
                    {committing ? (commitLabel === "Amend" ? "Amending..." : "Committing...") : commitLabel}
                  </PrimaryButton>
                ) : null}
              </span>
            </span>
          )}
          summaryClassName="text-[0.82em] leading-[1.5] text-muted"
        >
          {proposal ? (
            <ThreadFileChangeList
              changes={displayedChanges.map((change, index) => ({
                change: {
                  diff: change.diff,
                  kind: change.kind.type === "update"
                    ? { move_path: change.kind.move_path ?? null, type: "update" as const }
                    : change.kind,
                  path: change.path,
                },
                detailsAvailable: !compact,
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
        </ThreadDisclosure>}
      </div>
    </article>
  );
}
