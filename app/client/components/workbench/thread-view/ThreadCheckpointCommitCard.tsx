/*
 * Exports:
 * - ThreadCommitSummary: diff-free commit message and per-file totals shared by every commit display.
 * - CheckpointCommitCardState: distinguish static previews, pending enrichment, diff-free summaries, failures, and loaded proposals.
 * - getCheckpointProposalDisplayedChanges: choose fresh-commit or proposal changes for the selected mode.
 * - canCommitCheckpointProposal: decide whether the current message and mode can commit or amend.
 * - ThreadReadonlyCommitCard: the full card without controls, from a summary or an on-demand loaded proposal.
 * - ThreadCommitRow: one-line commit (icon, title, totals, short sha) for collapsed commit lists.
 * - default ThreadCheckpointCommitCard: render proposal fields, loading shapes, and edit/commit controls in full, compact or readonly layouts.
 */
"use client";

import type { KeyboardEvent, Ref } from "react";

import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { createGitArcOperationRejected, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import type { GitArcChangeTotal } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import PrimaryButton from "../../ui/PrimaryButton";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { AsteriskIcon, CheckIcon, GitArcProposalIcon, PlusIcon } from "../workbench-icons";
import RadioRow from "../../ui/RadioRow";
import PlaintextEditable from "./PlaintextEditable";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import { ThreadFileChangeList, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";

export interface ThreadCommitSummary {
  /** Exact total when a bounded receipt omits per-file summaries. */
  changeCount?: number;
  /** Null when the proposal predates recorded totals. */
  changes: readonly GitArcChangeTotal[] | null;
  committedSha?: string | null;
  description: string;
  title: string;
}

export type CheckpointCommitCardState =
  | { error: string; failure?: GitArcFailure; retryable: boolean; status: "error" }
  | { proposal: GitCheckpointProposal; status: "loaded" }
  | { status: "summary"; summary: ThreadCommitSummary }
  | { status: "pending" }
  | { status: "idle" };

/** `readonly` is the full card without controls; `compact-*` are the small tooltip layouts. */
type CheckpointCommitPresentation = "compact-commit" | "compact-preview" | "full" | "readonly";

/** Diff-free file rows: totals only, never expandable. */
function summaryChangeRows(changes: readonly GitArcChangeTotal[], sourceItemId: string): ThreadFileChangeListChange[] {
  return changes.map(({ additions, deletions, kind, path }, sourceChangeIndex) => ({
    change: { diff: "", kind: kind === "update" ? { move_path: null, type: "update" } : { type: kind }, path },
    detailsAvailable: false,
    sourceChangeIndex,
    sourceItemId,
    summaryTotals: { additions, deletions },
  }));
}

const noop = () => undefined;

/**
 * The full card without controls, for commits shown away from the Git arc panel: stack receipts (summaries) and
 * opened transcript proposals (on-demand loads). `fallbackTitle` names a commit that has not loaded yet.
 */
export function ThreadReadonlyCommitCard({
  fallbackTitle,
  state,
  ...props
}: {
  fallbackTitle?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  sourceItemId: string;
  state: Exclude<CheckpointCommitCardState, { status: "idle" }>;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const message = state.status === "loaded" ? state.proposal : state.status === "summary" ? state.summary : null;
  return (
    <ThreadCheckpointCommitCard
      {...props}
      commitMode={state.status === "loaded" ? state.proposal.mode : "commit"}
      committing={false}
      description={message?.description ?? ""}
      freshCommitAvailable={false}
      includeNewer={false}
      messageAvailability={{ description: Boolean(message), title: Boolean(message || fallbackTitle?.trim()) }}
      onCommit={noop}
      onCommitModeChange={noop}
      onDescriptionChange={noop}
      onIncludeNewerChange={noop}
      onRetry={noop}
      onTitleChange={noop}
      paths={[]}
      presentation="readonly"
      state={state}
      title={message?.title ?? fallbackTitle ?? ""}
    />
  );
}

export function ThreadCommitRow({ summary }: { summary: Pick<ThreadCommitSummary, "changes" | "committedSha" | "title"> | null }) {
  return (
    <DisclosureStaticRow
      className="!py-0.5"
      marker={<GitArcProposalIcon size={16} />}
      markerLabel="commit"
      summary={summary ? (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-text">{summary.title}</span>
          {summary.changes ? <ThreadGitArcChangeTotals changes={summary.changes} /> : null}
          {summary.committedSha ? (
            <span className="shrink-0 font-mono text-[0.86em] text-fg/muted">{summary.committedSha.slice(0, 8)}</span>
          ) : null}
        </span>
      ) : (
        <span aria-hidden="true" className="flex h-[1.5em] items-center">
          <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
        </span>
      )}
      summaryClassName="text-[0.88em] leading-[1.6] text-fg/muted"
    />
  );
}

export function getCheckpointProposalDisplayedChanges(
  proposal: GitCheckpointProposal | null,
  commitMode: "amend" | "commit",
) {
  return proposal?.mode === "amend" && commitMode === "commit" && proposal.freshChanges
    ? proposal.freshChanges
    : proposal?.changes ?? [];
}

export function canCommitCheckpointProposal({
  commitMode,
  committing,
  description,
  presentation = "full",
  proposal,
  selectedUnclaimedCount,
  title,
}: {
  commitMode: "amend" | "commit";
  committing: boolean;
  description: string;
  presentation?: CheckpointCommitPresentation;
  proposal: GitCheckpointProposal | null;
  selectedUnclaimedCount: number;
  title: string;
}) {
  const committedAmendable = proposal?.status === "committed" && proposal.amendability?.status === "available";
  const messageChanged = proposal?.status === "committed"
    && (title.trim() !== proposal.title.trim() || description.trim() !== proposal.description.trim());
  return !committing
    && Boolean(title.trim())
    && !(proposal?.status === "proposed" && commitMode === "commit"
      && !getCheckpointProposalDisplayedChanges(proposal, commitMode).length && !selectedUnclaimedCount)
    && Boolean(presentation === "compact-commit"
      ? proposal?.status === "proposed"
      : presentation === "full" && (proposal?.status === "proposed" || (committedAmendable && messageChanged)));
}

export default function ThreadCheckpointCommitCard({
  commitMode,
  committing,
  description,
  embedded = false,
  freshCommitAvailable,
  includeNewer,
  selectedUnclaimedPaths = [],
  messageAvailability,
  onCommit,
  onCommitModeChange,
  onDescriptionChange,
  onIncludeNewerChange,
  onUnclaimedOpen,
  onUnclaimedChange,
  onRetry,
  onTitleChange,
  observationRef,
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  presentation = "full",
  queued = false,
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
  selectedUnclaimedPaths?: readonly string[];
  messageAvailability?: { title: boolean; description: boolean };
  onCommit: () => void;
  onCommitModeChange: (value: "amend" | "commit") => void;
  onDescriptionChange: (value: string) => void;
  onIncludeNewerChange: (value: boolean) => void;
  onUnclaimedOpen?: () => void;
  onUnclaimedChange?: (path: string, checked: boolean) => void;
  onRetry: () => void;
  onTitleChange: (value: string) => void;
  observationRef?: Ref<HTMLElement>;
  paths: string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  presentation?: CheckpointCommitPresentation;
  /** Waiting its turn in a running batched acceptance. */
  queued?: boolean;
  sourceItemId: string;
  state: CheckpointCommitCardState;
  title: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const proposal = state.status === "loaded" ? state.proposal : null;
  const summary = state.status === "summary" ? state.summary : null;
  const compact = presentation === "compact-commit" || presentation === "compact-preview";
  /** Shows commit controls: the full card and the compact tooltip commit. */
  const interactive = presentation === "full" || presentation === "compact-commit";
  const readOnly = !interactive;
  const pending = state.status === "pending";
  const titlePending = pending && !(messageAvailability?.title ?? Boolean(title.trim()));
  const descriptionPending = pending && !(messageAvailability?.description ?? Boolean(description.trim()));
  const titleClassName = compact ? "min-h-5 text-[0.88em]" : "min-h-6 text-[0.94em]";
  const descriptionClassName = compact ? "min-h-5 text-[0.76em] leading-4" : "min-h-7 text-[0.8em] leading-5";
  const committedAmendable = proposal?.status === "committed" && proposal.amendability?.status === "available";
  const committedOutsideProposal = proposal?.status === "unavailable"
    && proposal.unavailableReasonCode === "committed-outside-proposal";
  const editable = !readOnly && (!proposal || proposal.status === "proposed" || committedAmendable);
  const displayedChanges = getCheckpointProposalDisplayedChanges(proposal, commitMode);
  const summaryChanges = summary?.changes ?? null;
  const summaryChangeCount = summary?.changeCount ?? summaryChanges?.length ?? null;
  const fileCount = proposal ? displayedChanges.length : summaryChangeCount ?? paths.length;
  const committedSha = proposal?.status === "committed" ? proposal.committedSha : summary?.committedSha ?? null;
  const amendTargetMessage = proposal?.amendTargetMessage ?? null;
  const titleWillChange = commitMode === "amend"
    && amendTargetMessage !== null
    && title.trim() !== amendTargetMessage.title.trim();
  const descriptionWillChange = commitMode === "amend"
    && amendTargetMessage !== null
    && description.trim() !== amendTargetMessage.description.trim();
  const changeSummary = proposal || summaryChangeCount !== null || paths.length
    ? `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
    : "Arc changes";
  const canCommit = canCommitCheckpointProposal({
    commitMode,
    committing,
    description,
    presentation,
    proposal,
    selectedUnclaimedCount: selectedUnclaimedPaths.length,
    title,
  });
  const commitLabel = proposal?.status === "committed" || commitMode === "amend" ? "Amend" : "Commit";
  // Stacked proposals wait for lower layers; commit-all still reaches them because it commits in stack order.
  const waitingForLayer = proposal?.status === "proposed" ? proposal.waitingForLayer ?? null : null;
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
      ref={observationRef}
      aria-label="Checkpoint commit proposal"
      aria-busy={pending || undefined}
      className={compact
        ? "w-full px-0 py-0"
        : presentation === "readonly"
          ? "w-full py-2"
          : embedded
            ? "w-full px-3 py-2.5"
            : "my-2 w-full rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2 px-3 py-2.5"}
      data-thread-checkpoint-card="true"
      data-thread-checkpoint-card-embedded={embedded ? "true" : undefined}
      data-thread-checkpoint-card-presentation={presentation}
    >
      <div className="flex min-w-0 gap-2" data-thread-checkpoint-card-content="true">
        <span className={compact
          ? "inline-flex h-6 w-5 shrink-0 items-center justify-center text-fg/muted"
          : "mt-1 inline-flex size-5 shrink-0 items-center justify-center text-fg/muted"}
          aria-hidden="true"
        >
          <GitArcProposalIcon size={20} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-start gap-1">
            {titleWillChange ? (
              <span aria-label="Commit title differs from current commit" className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-fg/muted" role="img">
                <AsteriskIcon size={14} />
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
                  className={`${titleClassName} w-full bg-transparent px-0 py-0.5 font-medium outline-none data-[empty=true]:before:text-fg/muted data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent`}
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
                <span aria-label="Commit description differs from current commit" className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-fg/muted" role="img">
                  <AsteriskIcon size={14} />
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
                    className={`${descriptionClassName} w-full whitespace-pre-wrap bg-transparent px-0 py-0.5 text-fg/muted outline-none data-[empty=true]:before:text-fg/32 data-[empty=true]:before:content-[attr(data-placeholder)] focus:bg-transparent focus:text-text`}
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
          <DisclosureStaticRow
            className="mt-1.5 py-0.5"
            marker={<span className="size-3 rounded workbench-skeleton" />}
            summaryClassName="text-[0.82em] leading-[1.5]"
            summary={(
              <span className="flex min-w-0 items-center justify-between gap-3" aria-hidden="true">
                <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
                {interactive ? <span className="h-7 w-16 shrink-0 rounded-full workbench-skeleton" /> : null}
              </span>
            )}
          />
        ) : <Disclosure
          className="mt-1.5 py-0.5"
          contentClassName="mt-1 rounded-[0.65rem] bg-fg/4 px-2"
          summary={(
            <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="inline-flex min-w-0 items-baseline gap-2">
                <span>{changeSummary}</span>
                {proposal ? <ThreadGitArcChangeTotals changes={displayedChanges} />
                  : summaryChanges ? <ThreadGitArcChangeTotals changes={summaryChanges} /> : null}
              </span>
              <span
                className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2"
                data-thread-checkpoint-card-actions="true"
                data-thread-summary-action="true"
              >
                {interactive && proposal?.status === "proposed" && proposal.includeNewerAvailable ? (
                  <WorkbenchCheckbox
                    checked={includeNewer}
                    label="Include newer changes"
                    onChange={onIncludeNewerChange}
                  />
                ) : null}
                {interactive && proposal?.status === "proposed" && freshCommitAvailable ? (
                  <RadioRow
                    ariaLabel="Commit mode"
                    disabled={committing}
                    onChange={onCommitModeChange}
                    options={[
                      {
                        ariaLabel: "Amend",
                        icon: <AsteriskIcon size={14} />,
                        label: "Amend",
                        value: "amend",
                      },
                      {
                        ariaLabel: "Commit fresh",
                        icon: <PlusIcon size={14} />,
                        label: "Commit fresh",
                        value: "commit",
                      },
                    ]}
                    value={commitMode}
                  />
                ) : null}
                {presentation === "full" && proposal?.status === "committed" && (canCommit || committing) ? (
                  <PrimaryButton className="!px-3 !py-1.5 !text-[0.78rem]" data-thread-checkpoint-commit-action="true" disabled={!canCommit} onClick={onCommit} pendingHalo={committing}>
                    {committing ? "Amending..." : "Amend"}
                  </PrimaryButton>
                ) : proposal?.status === "committed" || (!proposal && committedSha) ? (
                  <span className="inline-flex items-center gap-2 text-[0.78em] text-fg/muted">
                    <CheckIcon className="text-[color:var(--success)]" size={16} />
                    <span>Committed</span>
                    {committedSha ? <span className="font-mono text-text">{committedSha.slice(0, 8)}</span> : null}
                  </span>
                ) : proposal?.status === "superseded" ? (
                  <span className="text-[0.78em] text-fg/muted">Superseded</span>
                ) : committedOutsideProposal ? (
                  <span
                    className="inline-flex items-center gap-2 text-[0.78em] text-fg/muted"
                    data-thread-checkpoint-committed-outside-proposal="true"
                  >
                    <CheckIcon className="text-[color:var(--success)]" size={16} />
                    <span>Committed outside proposal</span>
                  </span>
                ) : proposal?.status === "unavailable" ? (
                  <span className="text-[0.78em] text-[color:var(--danger)]">
                    {proposal.unavailableReason || "This proposal is no longer mechanically available."}
                  </span>
                ) : state.status === "error" ? (
                  state.retryable ? (
                    <button type="button" className="rounded-full px-2.5 py-1 text-[0.78em] text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text" onClick={onRetry}>
                      Try again
                    </button>
                  ) : <span className="text-[0.78em] text-[color:var(--danger)]">Unavailable</span>
                ) : pending || summary ? (
                  // A summary has no readiness yet: hydration decides whether the commit control is available.
                  interactive ? <span className="h-7 w-16 rounded-full workbench-skeleton" aria-hidden="true" /> : null
                ) : interactive ? (
                  <PrimaryButton
                    className={`
                      !px-3 ${compact ? "!py-1" : "!py-1.5"}
                      !text-[0.78rem]
                    `}
                    data-thread-checkpoint-commit-action="true"
                    // Commit-all may still reach a waiting card once lower layers land, so only the button waits.
                    disabled={!canCommit || queued || Boolean(waitingForLayer && !committing)}
                    onClick={onCommit}
                    pendingHalo={committing}
                    title={waitingForLayer && !committing && !queued ? `Commit "${waitingForLayer}" first.` : undefined}
                  >
                    {committing ? (commitLabel === "Amend" ? "Amending..." : "Committing...") : queued ? "Queued" : commitLabel}
                  </PrimaryButton>
                ) : null}
              </span>
            </span>
          )}
          summaryClassName="text-[0.82em] leading-[1.5] text-fg/muted"
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
          ) : summaryChanges ? (
            <ThreadFileChangeList
              changes={summaryChangeRows(summaryChanges, sourceItemId)}
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
            <p className="m-0 py-2 text-[0.78em] leading-[1.6] text-fg/muted">
              The arc&apos;s claimed changes will appear here.
            </p>
          )}
          {interactive && proposal?.status === "proposed" && proposal.unclaimedDirtAvailable ? (
            <Disclosure
              className="py-1"
              contentClassName="pl-6"
              summary="Unclaimed dirt"
              summaryClassName="text-[0.82em] leading-[1.5]"
              onToggle={event => {
                if (event.target === event.currentTarget && event.currentTarget.open) onUnclaimedOpen?.();
              }}
            >
              {proposal.unclaimedDirt ? proposal.unclaimedDirt.changes.length ? (
                <ThreadFileChangeList
                  changes={proposal.unclaimedDirt.changes.map((change, index) => ({
                    change: {
                      diff: change.diff,
                      kind: change.kind.type === "update"
                        ? { move_path: change.kind.move_path ?? null, type: "update" as const }
                        : change.kind,
                      path: change.path,
                    },
                    detailsAvailable: !compact,
                    sourceChangeIndex: index,
                    sourceItemId: `${sourceItemId}:unclaimed`,
                    selection: {
                      checked: selectedUnclaimedPaths.includes(change.path),
                      disabled: committing || readOnly || !onUnclaimedChange,
                      onChange: checked => onUnclaimedChange?.(change.path, checked),
                    },
                  }))}
                  projectFilePaths={projectFilePaths}
                  projectId={projectId}
                  projectRootPath={projectRootPath}
                  workspaceRoots={workspaceRoots}
                />
              ) : (
                <p className="m-0 py-2 text-[0.82em] text-fg/muted">No unclaimed changes.</p>
              ) : (
                <p className="m-0 py-2 text-[0.82em] text-fg/muted" role="status">Loading unclaimed changes...</p>
              )}
            </Disclosure>
          ) : null}
        </Disclosure>}
      </div>
    </article>
  );
}
