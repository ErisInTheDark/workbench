/*
 * Exports:
 * - ThreadCommitSummary: diff-free commit message and change totals shared by every commit display.
 * - CheckpointCommitCardState: distinguish static previews, pending enrichment, diff-free summaries, failures, and loaded proposals.
 * - ThreadCommitControls: edit and commit wiring that makes a commit card interactive.
 * - ThreadCommitMessage: an edited or fallback message shown instead of the state's own.
 * - ThreadCommitDisclosure: caller-owned open state and closed-line action for a collapsible commit.
 * - getCheckpointProposalDisplayedChanges: choose fresh-commit or proposal changes for the selected mode.
 * - canCommitCheckpointProposal: decide whether the current message and mode can commit or amend.
 * - default ThreadCheckpointCommitCard: the one commit and proposal renderer; a full card while editable or expanded, a toggle between one-line and full card when it has a body, otherwise a one-line row.
 */
"use client";

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { createGitArcOperationRejected, type GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import { summarizeGitArcChanges, type GitArcChangeTotals } from "workbench-shared/workbench/git/git-arc-change-totals";
import type { GitArcChangeTotal } from "workbench-shared/workbench/git/git-arc-receipts";
import PrimaryButton from "../../ui/PrimaryButton";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { AsteriskIcon, CheckIcon, GitArcProposalIcon, PlusIcon } from "../workbench-icons";
import RadioRow from "../../ui/RadioRow";
import PlaintextEditable from "./PlaintextEditable";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import { ThreadFileChangeList, type ThreadFileChangeListChange } from "./ThreadFileChangeItem";
import ThreadGitArcChangeTotals from "./ThreadGitArcChangeTotals";
import ChevronIcon from "../ChevronIcon";
import { useThreadWindowPin } from "./ThreadMeasuredContent";

export interface ThreadCommitSummary {
  /** Exact file count when a bounded receipt omits both its per-file list and line totals. */
  changeCount?: number;
  /** Per-file totals a receipt carries; observed summaries leave them to the loaded proposal. */
  changes?: readonly GitArcChangeTotal[];
  committedSha?: string | null;
  description: string;
  title: string;
  /** Null when unknown. */
  totals: GitArcChangeTotals | null;
}

export type CheckpointCommitCardState =
  | { error: string; failure?: GitArcFailure; retryable: boolean; status: "error" }
  | { proposal: GitCheckpointProposal; status: "loaded" }
  | { status: "summary"; summary: ThreadCommitSummary }
  | { status: "pending" }
  | { status: "idle" };

export interface ThreadCommitControls {
  commitMode: "amend" | "commit";
  committing: boolean;
  freshCommitAvailable: boolean;
  includeNewer: boolean;
  onCommit: () => void;
  onCommitModeChange: (value: "amend" | "commit") => void;
  onDescriptionChange: (value: string) => void;
  onIncludeNewerChange: (value: boolean) => void;
  onRetry: () => void;
  onTitleChange: (value: string) => void;
  onUnclaimedChange?: (path: string, checked: boolean) => void;
  onUnclaimedOpen?: () => void;
  /** Waiting its turn in a running batched acceptance. */
  queued?: boolean;
  selectedUnclaimedPaths?: readonly string[];
}

export interface ThreadCommitMessage {
  /** Which fields hold real content; unavailable fields are skeletons while the state is pending. */
  availability?: { description: boolean; title: boolean };
  description: string;
  title: string;
}

export interface ThreadCommitDisclosure {
  /** Shown beside the closed line, where the card's own controls are hidden. */
  closedAction?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

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

/** The one-line commit at card title weight: title, totals and short sha, or a skeleton while the title is unknown. */
function CommitLine({ committedSha, title, totals }: {
  committedSha: string | null;
  title: string | null;
  totals: GitArcChangeTotals | null;
}) {
  if (title === null) {
    return (
      <span aria-hidden="true" className="flex h-[1.5em] items-center">
        <span className="h-[1em] w-1/2 rounded workbench-skeleton" />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 truncate font-medium text-text">{title}</span>
      {totals ? (
        <span className="shrink-0 text-[0.87em]">
          <ThreadGitArcChangeTotals totals={totals} />
        </span>
      ) : null}
      {committedSha ? <span className="shrink-0 font-mono text-[0.86em] text-fg/muted">{committedSha.slice(0, 8)}</span> : null}
    </span>
  );
}

/**
 * The changed-files disclosure. Its default is fixed when it mounts: Disclosure follows a changing default until
 * touched, so a proposal accepted while open would otherwise pop its file list open on the way to collapsing.
 */
function CommitChanges({ children, openByDefault, summary }: { children: ReactNode; openByDefault: boolean; summary: ReactNode }) {
  const [defaultOpen] = useState(openByDefault);
  return (
    <Disclosure
      className="mt-1.5 py-0.5"
      contentClassName="mt-1 rounded-[0.65rem] bg-fg/4 px-2"
      defaultOpen={defaultOpen}
      summary={summary}
      summaryClassName="text-[0.82em] leading-[1.5] text-fg/muted"
    >
      {children}
    </Disclosure>
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
  interactive = true,
  proposal,
  selectedUnclaimedCount,
  title,
}: {
  commitMode: "amend" | "commit";
  committing: boolean;
  description: string;
  interactive?: boolean;
  proposal: GitCheckpointProposal | null;
  selectedUnclaimedCount: number;
  title: string;
}) {
  const committedAmendable = proposal?.status === "committed" && proposal.amendability?.status === "available";
  const messageChanged = proposal?.status === "committed"
    && (title.trim() !== proposal.title.trim() || description.trim() !== proposal.description.trim());
  return interactive
    && !committing
    && Boolean(title.trim())
    && !(proposal?.status === "proposed" && commitMode === "commit"
      && !getCheckpointProposalDisplayedChanges(proposal, commitMode).length && !selectedUnclaimedCount)
    && (proposal?.status === "proposed" || Boolean(committedAmendable && messageChanged));
}

export default function ThreadCheckpointCommitCard({
  controls,
  density = "normal",
  disclosure,
  expanded = false,
  message,
  observationRef,
  paths = [],
  sourceItemId,
  state,
}: {
  /** Present only where the card can edit and commit; without it every layout is readonly. */
  controls?: ThreadCommitControls;
  density?: "compact" | "normal";
  /** Makes even an editable card collapsible, with the caller owning whether it is open. */
  disclosure?: ThreadCommitDisclosure;
  /** The caller already discloses this one commit, so its body shows without another chevron. */
  expanded?: boolean;
  /** Defaults to the state's own message. */
  message?: ThreadCommitMessage;
  /** Demand target: only rendered cards observe, so closed lines never load. */
  observationRef?: (element: HTMLElement | null) => void;
  /** Intended paths, listed before a proposal has loaded its real changes. */
  paths?: readonly string[];
  sourceItemId: string;
  state: CheckpointCommitCardState;
}) {
  const proposal = state.status === "loaded" ? state.proposal : null;
  const summary = state.status === "summary" ? state.summary : null;
  const title = message?.title ?? proposal?.title ?? summary?.title ?? "";
  const description = message?.description ?? proposal?.description ?? summary?.description ?? "";
  const compact = density === "compact";
  const interactive = Boolean(controls);
  const commitMode = controls?.commitMode ?? proposal?.mode ?? "commit";
  const committing = controls?.committing ?? false;
  const selectedUnclaimedPaths = controls?.selectedUnclaimedPaths ?? [];
  const pending = state.status === "pending";
  const titlePending = pending && !(message?.availability?.title ?? Boolean(title.trim()));
  const descriptionPending = pending && !(message?.availability?.description ?? Boolean(description.trim()));
  const titleClassName = compact ? "min-h-5 text-[0.88em]" : "min-h-6 text-[0.94em]";
  const descriptionClassName = compact ? "min-h-5 text-[0.76em] leading-4" : "min-h-7 text-[0.8em] leading-5";
  const committedAmendable = proposal?.status === "committed" && proposal.amendability?.status === "available";
  const committedOutsideProposal = proposal?.status === "unavailable"
    && proposal.unavailableReasonCode === "committed-outside-proposal";
  const editable = interactive && (!proposal || proposal.status === "proposed" || committedAmendable);
  const displayedChanges = getCheckpointProposalDisplayedChanges(proposal, commitMode);
  const summaryChangeCount = summary?.totals?.files ?? summary?.changeCount ?? null;
  const fileCount = proposal ? displayedChanges.length : summaryChangeCount ?? paths.length;
  const committedSha = proposal?.status === "committed" ? proposal.committedSha : summary?.committedSha ?? null;
  const committed = proposal ? proposal.status === "committed" : Boolean(committedSha);
  const lineTotals = proposal ? summarizeGitArcChanges(displayedChanges) : summary?.totals ?? null;
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
    interactive,
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
  const amendAction = interactive && proposal?.status === "committed" && (canCommit || committing);
  // A controlled card may still load a body; a readonly one only opens onto what it already knows.
  const hasBody = interactive || Boolean(proposal) || Boolean(description.trim()) || Boolean(summaryChangeCount) || paths.length > 0;
  const layout = expanded || state.status === "error" || (interactive && !committed && !disclosure) ? "card"
    : hasBody || disclosure ? "toggle" : "row";
  // An amendment in flight stays open even if the card remounts.
  const [ownOpen, setOwnOpen] = useState(committing);
  const open = disclosure ? disclosure.open : ownOpen || committing;
  // Like Disclosure, only user toggles pin windowed ancestors, so untouched cards remount identically.
  const [userToggled, setUserToggled] = useState(false);
  const windowPin = useThreadWindowPin();
  useEffect(() => {
    if (!userToggled) return;
    windowPin.pin();
    return () => windowPin.unpin();
  }, [userToggled, windowPin]);
  const toggle = () => {
    setUserToggled(true);
    if (disclosure) disclosure.onOpenChange(!open);
    else setOwnOpen(!open);
  };
  // Start chevron, as Disclosure draws it: pointing right while closed, down while open.
  const toggleChevron = (
    <ChevronIcon
      className={`
        shrink-0 text-fg/muted transition-transform
        ${open ? "" : "transform-[rotate(-90deg)]"}
      `}
      size={18}
    />
  );
  const cardIcon = (
    <span
      aria-label="commit"
      className={compact
        ? "inline-flex h-6 w-5 shrink-0 items-center justify-center text-fg/muted"
        : "mt-1 inline-flex size-5 shrink-0 items-center justify-center text-fg/muted"}
      role="img"
    >
      <GitArcProposalIcon size={20} />
    </span>
  );
  const cardPadding = compact ? "px-0 py-0" : interactive ? "py-2.5" : "py-2";

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
    controls?.onCommit();
  };

  const titleField = (
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
            onChange={controls?.onTitleChange ?? (() => undefined)}
            onKeyDown={commitFromEditable}
            placeholder="Commit title"
            readOnly={!editable}
            value={title}
          />
        )}
      </div>
    </div>
  );
  const descriptionField = pending || editable || description.trim() ? (
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
            onChange={controls?.onDescriptionChange ?? (() => undefined)}
            onKeyDown={commitFromEditable}
            placeholder="Optional description"
            readOnly={!editable}
            value={description}
          />
        )}
      </div>
    </div>
  ) : null;

  const actions = (
    <span
      className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2"
      data-thread-checkpoint-card-actions="true"
      data-thread-summary-action="true"
    >
      {controls && proposal?.status === "proposed" && proposal.includeNewerAvailable ? (
        <WorkbenchCheckbox
          checked={controls.includeNewer}
          label="Include newer changes"
          onChange={controls.onIncludeNewerChange}
        />
      ) : null}
      {controls && proposal?.status === "proposed" && controls.freshCommitAvailable ? (
        <RadioRow
          ariaLabel="Commit mode"
          disabled={committing}
          onChange={controls.onCommitModeChange}
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
      {amendAction ? (
        <PrimaryButton data-thread-checkpoint-commit-action="true" shape="compact" disabled={!canCommit} onClick={controls?.onCommit} pendingHalo={committing}>
          {committing ? "Amending..." : "Amend"}
        </PrimaryButton>
      ) : committed ? (
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
        state.retryable && controls ? (
          <button type="button" className="rounded-full px-2.5 py-1 text-[0.78em] text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text" onClick={controls.onRetry}>
            Try again
          </button>
        ) : <span className="text-[0.78em] text-[color:var(--danger)]">Unavailable</span>
      ) : pending || summary ? (
        // A summary has no readiness yet: hydration decides whether the commit control is available.
        interactive ? <span className="h-7 w-16 rounded-full workbench-skeleton" aria-hidden="true" /> : null
      ) : controls ? (
        <PrimaryButton
          className={compact ? "!py-1" : ""}
          data-thread-checkpoint-commit-action="true"
          shape="compact"
          // Commit-all may still reach a waiting card once lower layers land, so only the button waits.
          disabled={!canCommit || controls.queued || Boolean(waitingForLayer && !committing)}
          onClick={controls.onCommit}
          pendingHalo={committing}
          title={waitingForLayer && !committing && !controls.queued ? `Commit "${waitingForLayer}" first.` : undefined}
        >
          {committing ? (commitLabel === "Amend" ? "Amending..." : "Committing...") : controls.queued ? "Queued" : commitLabel}
        </PrimaryButton>
      ) : null}
    </span>
  );

  const fileList = (changes: ThreadFileChangeListChange[]) => (
    <ThreadFileChangeList changes={changes} />
  );
  const knownChanges: ReactNode = proposal ? fileList(displayedChanges.map((change, index) => ({
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
  }))) : summary?.changes ? fileList(summaryChangeRows(summary.changes, sourceItemId)) : paths.length ? fileList(paths.map((path, index) => ({
    change: {
      diff: "",
      kind: { move_path: null, type: "update" as const },
      path,
    },
    detailsAvailable: false,
    presentationLabel: "Changed",
    sourceChangeIndex: index,
    sourceItemId,
  }))) : null;

  const articleProps = {
    "aria-busy": pending || undefined,
    "aria-label": "Checkpoint commit proposal",
    "data-thread-checkpoint-card": "true",
    "data-thread-checkpoint-card-layout": layout,
  } as const;

  // The start chevron leads the whole card, so icon, message and changes keep one column open or closed.
  const toggleButton = (
    <button
      aria-expanded={open}
      aria-label={open ? "Collapse commit" : "Expand commit"}
      className={`
        inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded
        hover:text-text focus-visible:text-text focus-visible:outline-none
        ${compact ? "mt-0.5" : "mt-1"}
      `}
      data-thread-checkpoint-card-toggle="true"
      onClick={toggle}
      type="button"
    >
      {toggleChevron}
    </button>
  );

  const closedLine = (
    <>
      {cardIcon}
      <span
        className={`
          flex min-w-0 flex-1 items-center py-0.5
          ${titleClassName}
        `}
      >
        <CommitLine committedSha={committedSha} title={titlePending ? null : title} totals={lineTotals} />
      </span>
    </>
  );

  // A title-only commit is a closed card that cannot open; the chevron gutter keeps it aligned beside toggles.
  if (layout === "row") {
    return (
      <article {...articleProps} className={`w-full ${cardPadding}`} ref={observationRef}>
        <div className="flex min-w-0 items-start gap-1">
          <span aria-hidden="true" className="size-5 shrink-0" />
          <div className="flex min-w-0 flex-1 items-start gap-2">{closedLine}</div>
        </div>
      </article>
    );
  }

  // A closed toggle is only its line at the card's own padding, icon and title type, so opening moves nothing.
  if (layout === "toggle" && !open) {
    return (
      <article {...articleProps} className={`w-full ${cardPadding}`}>
        <div className="flex min-w-0 items-start gap-1">
          {toggleButton}
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left"
            onClick={toggle}
            tabIndex={-1}
            type="button"
          >
            {closedLine}
          </button>
          {disclosure?.closedAction ?? null}
        </div>
      </article>
    );
  }
  const toggleable = layout === "toggle";
  // Clicking a readonly title collapses the card; an editable one keeps its clicks for editing.
  const titleToggles = toggleable && !editable;

  return (
    <article
      {...articleProps}
      ref={observationRef}
      className={`w-full ${cardPadding}`}
    >
      <div className="flex min-w-0 items-start gap-1">
      {toggleable ? toggleButton : null}
      <div className="min-w-0 flex-1">
      <div className="flex min-w-0 gap-2" data-thread-checkpoint-card-content="true">
        {cardIcon}
        <div className="min-w-0 flex-1 space-y-1">
          <div
            className={titleToggles ? "cursor-pointer [&_*]:cursor-pointer" : undefined}
            onClick={titleToggles ? toggle : undefined}
          >
            {titleField}
          </div>
          {descriptionField}
        </div>
      </div>

      {failure ? (
        <div data-thread-checkpoint-card-error="true">
          <ThreadGitArcFailure failure={failure} />
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
        ) : <CommitChanges
          // Opening a settled commit means reading it, so its files come with it; pending work keeps its list tucked.
          openByDefault={toggleable && (committed || !interactive)}
          summary={(
            <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="inline-flex min-w-0 items-baseline gap-2">
                <span>{changeSummary}</span>
                {lineTotals ? <ThreadGitArcChangeTotals totals={lineTotals} /> : null}
              </span>
              {actions}
            </span>
          )}
        >
          {knownChanges ?? (
            <p className="m-0 py-2 text-[0.78em] leading-[1.6] text-fg/muted">
              The arc&apos;s claimed changes will appear here.
            </p>
          )}
          {controls && proposal?.status === "proposed" && proposal.unclaimedDirtAvailable ? (
            <Disclosure
              className="py-1"
              contentClassName="pl-6"
              summary="Unclaimed dirt"
              summaryClassName="text-[0.82em] leading-[1.5]"
              onToggle={event => {
                if (event.target === event.currentTarget && event.currentTarget.open) controls.onUnclaimedOpen?.();
              }}
            >
              {proposal.unclaimedDirt ? proposal.unclaimedDirt.changes.length ? fileList(proposal.unclaimedDirt.changes.map((change, index) => ({
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
                  disabled: committing || !controls.onUnclaimedChange,
                  onChange: checked => controls.onUnclaimedChange?.(change.path, checked),
                },
              }))) : (
                <p className="m-0 py-2 text-[0.82em] text-fg/muted">No unclaimed changes.</p>
              ) : (
                <p className="m-0 py-2 text-[0.82em] text-fg/muted" role="status">Loading unclaimed changes...</p>
              )}
            </Disclosure>
          ) : null}
        </CommitChanges>}
      </div>
      </div>
      </div>
    </article>
  );
}
