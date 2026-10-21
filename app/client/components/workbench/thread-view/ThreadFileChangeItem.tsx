/*
 * Exports:
 * - default ThreadFileChangeItem: render adjacent native and canonical file operations as step rows, growing back-to-back edits of one kind or identical native failed attempts on one file into one row,
 *   each timed from its first piece starting to its last finishing; while `editing`, the last row stays in progress; `status` mode shows only that last row.
 * - ThreadFileChangeList: render reusable file-change rows from already-shaped file update changes, marking binary diffs without previews.
 * - ThreadFileChangePreviewList: render non-disclosure file-change previews with established row presentation.
 * - ThreadFileChangeTotals: render shared cumulative addition and deletion counts.
 * - ThreadFileChangeListChange: reusable file-change row input.
 * - getThreadFileChangeTotals: cumulative counts using the same precedence as file rows.
 * - ThreadFileChangeEntry/getThreadFileChangeEntries: per-file change kind and counts for summaries.
 * - getStitchedNativeRowChange: one row input from stitched native pieces: accumulated counts and hunks for applied runs, attempt count and latest attempt for failure runs, failure-only evidence.
 */
"use client";

import type { ComponentType, ReactNode } from "react";

import { toWorkspaceDisplayPath } from "../../../workbench/markdown/markdown-links";
import { useProject } from "../use-projects";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import {
  getNativeFileChanges, getNativeFileOperationOutcome, type NativeFileOperationItem,
} from "../../../workbench/thread/thread-command-matchers";
import type { FileChangeAnalysis } from "workbench-shared/workbench/thread/file-change-analysis";
import { enterMotionClassName } from "../../../tailwind/enter-motion-classes";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "workbench-shared/workbench/thread/unified-diff";
import ProjectFilePath from "../ProjectFilePath";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon, LoaderIcon, type IconProps } from "../workbench-icons";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import ThreadStepRow from "./ThreadStepRow";
import { getThreadFileChangeMotionIdentity } from "./ThreadEntryMotionController";
import { ThreadEntryMotion } from "./thread-scroll-viewport-context";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadDurationText from "./ThreadDurationText";
import { formatToolCallOutput } from "./format-thread-tool-call";
import {
  getStitchedRowSpan, stitchFileOperationRows, type StitchedCanonicalFileRow, type StitchedNativeFilePiece, type StitchedNativeFileRow,
} from "./thread-file-change-stitching";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { ThreadStepProgress } from "./ThreadStepRow";

type FileChangeItem = WorkbenchFileChangeItem;
type NativeFileItem = NativeFileOperationItem;
type FileOperationItem = FileChangeItem | NativeFileItem;
type FileUpdateChange = FileChangeItem["changes"][number];

export function getThreadFileChangeTotals(items: readonly FileOperationItem[]) {
  return items.reduce((total, item) => {
    if (item.type !== "fileChange") {
      if (getNativeFileOperationOutcome(item) !== "completed") return total;
      for (const entry of getNativeFileChanges(item)) {
        const counts = parseFileChangeDiff(entry.change);
        total.additions += counts.additions;
        total.deletions += counts.deletions;
      }
      return total;
    }
    for (const change of item.changes) {
      const counts = getFileChangeCounts(item, change);
      total.additions += counts.additions;
      total.deletions += counts.deletions;
    }
    return total;
  }, { additions: 0, deletions: 0 });
}

export interface ThreadFileChangeEntry {
  additions: number;
  deletions: number;
  kind: FileUpdateChange["kind"]["type"];
  path: string;
}

/** One entry per changed file per operation, counted with the same precedence as file rows; failed operations change nothing. */
export function getThreadFileChangeEntries(items: readonly FileOperationItem[]): ThreadFileChangeEntry[] {
  return items.flatMap(item => {
    if (item.type !== "fileChange") {
      if (getNativeFileOperationOutcome(item) === "failed") return [];
      return getNativeFileChanges(item).map(({ change, summaryTotals }) => ({
        ...(summaryTotals ?? countsOf(parseFileChangeDiff(change))), kind: change.kind.type, path: change.path,
      }));
    }
    if (item.status === "failed" || item.status === "declined") return [];
    return item.changes.map(change => ({ ...getFileChangeCounts(item, change), kind: change.kind.type, path: change.path }));
  });
}

function countsOf({ additions, deletions }: { additions: number; deletions: number }) {
  return { additions, deletions };
}

function getFileChangeCounts(item: FileChangeItem, change: FileUpdateChange) {
  const analysis = item.status !== "completed" && item.workbenchFailureKind !== "unclaimed" ? change.workbenchAnalysis : undefined;
  if (analysis) return { additions: analysis.additions, deletions: analysis.deletions };
  if (change.workbenchAdditions !== undefined || change.workbenchDeletions !== undefined) {
    return { additions: change.workbenchAdditions ?? 0, deletions: change.workbenchDeletions ?? 0 };
  }
  const diff = parseFileChangeDiff(change);
  return { additions: diff.additions, deletions: diff.deletions };
}

interface ParsedFileChange {
  change: FileUpdateChange;
  danger: boolean;
  detailsAvailable: boolean;
  diff: ParsedUnifiedDiff;
  displayPath: string;
  failedAttempts: number;
  movePathDisplay: string | null;
  presentationLabel?: string;
  sourceChangeIndex: number;
  sourceItemId: string;
  staticMarker: boolean;
  summaryTotals: { additions: number; deletions: number };
}

export interface ThreadFileChangeListChange {
  change: FileUpdateChange;
  details?: ReactNode;
  danger?: boolean;
  /** Pre-parsed diff, used when one row presents several changes; otherwise parsed from `change`. */
  diff?: ParsedUnifiedDiff;
  detailsAvailable?: boolean;
  /** Failed attempts merged into this row; more than one shows a repeat count. */
  failedAttempts?: number;
  showDiff?: boolean;
  presentationLabel?: string;
  sourceChangeIndex?: number;
  sourceItemId?: string;
  staticMarker?: boolean;
  summaryTotals?: { additions: number; deletions: number };
  selection?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void };
  /** Step rows: how long the row's work took, from its first piece starting. */
  span?: ReturnType<typeof getStitchedRowSpan>;
  /** Step rows: still being worked on, so it reads in progress and its duration ticks from the span's start. */
  editing?: boolean;
}

interface FileChangePresentation {
  completedLabel: string;
  failureVerb: string;
  Icon: ComponentType<IconProps>;
  inProgressLabel: string;
}

function assertNeverFileChangeKind (kind: never): never {
  throw new Error(`Unsupported file change kind: ${JSON.stringify(kind)}`);
}

export function ThreadFileChangeTotals ({
  additions,
  animateChanges = false,
  deletions,
}: {
  additions: number;
  animateChanges?: boolean;
  deletions: number;
}) {
  if (!additions && !deletions) {
    return null;
  }

  const tickClassName = animateChanges ? "inline-block animate-tick motion-reduce:animate-none" : "";
  return (
    <span className="inline-flex items-baseline gap-2 font-mono text-[0.78em] leading-[1.6]">
      {additions ? (
        <span
          className={`${tickClassName} text-[color:color-mix(in_srgb,var(--success)_78%,var(--text)_22%)]`}
          key={animateChanges ? `additions-${additions}` : "additions"}
        >
          +{additions}
        </span>
      ) : null}
      {deletions ? (
        <span
          className={`${tickClassName} text-[color:color-mix(in_srgb,var(--danger)_78%,var(--text)_22%)]`}
          key={animateChanges ? `deletions-${deletions}` : "deletions"}
        >
          -{deletions}
        </span>
      ) : null}
    </span>
  );
}

function getFileChangePresentation (change: FileUpdateChange): FileChangePresentation {
  switch (change.kind.type) {
    case "add":
      return {
        completedLabel: "Created",
        failureVerb: "create",
        Icon: FileAddIcon,
        inProgressLabel: "Creating",
      };
    case "delete":
      return {
        completedLabel: "Deleted",
        failureVerb: "delete",
        Icon: FileDeleteIcon,
        inProgressLabel: "Deleting",
      };
    case "update":
      return change.kind.move_path
        ? {
          completedLabel: "Moved",
          failureVerb: "move",
          Icon: FileMoveIcon,
          inProgressLabel: "Moving",
        }
        : {
          completedLabel: "Edited",
          failureVerb: "edit",
          Icon: FileUpdateIcon,
          inProgressLabel: "Editing",
        };
    default:
      return assertNeverFileChangeKind(change.kind);
  }
}

function getFileChangeLifecycleLabel(change: FileUpdateChange, item: Pick<FileChangeItem, "status" | "workbenchPolicy" | "workbenchFailureKind">, analysis?: FileChangeAnalysis) {
  const presentation = getFileChangePresentation(change);
  if (analysis) {
    switch (analysis.outcome) {
      case "present": return presentation.completedLabel;
      case "unapplied": return `Failed to ${presentation.failureVerb}`;
      case "partial": return "Partially edited";
      case "copied": return "Copied";
      case "uncertain": return `Could not verify ${presentation.failureVerb}`;
    }
  }
  if (item.workbenchPolicy === "automaticEscalation") return `Failed to ${presentation.failureVerb}`;
  switch (item.status) {
    case "inProgress":
      return presentation.inProgressLabel;
    case "completed":
      return presentation.completedLabel;
    case "failed":
      return `Failed to ${presentation.failureVerb}${item.workbenchFailureKind === "unclaimed" ? " unclaimed" : ""}`;
    case "declined":
      return `Failed to ${presentation.failureVerb} declined`;
    default:
      return assertNeverFileChangeKind(item.status);
  }
}

function parseWholeFileTextDiff (diffText: string, lineType: "addition" | "deletion"): ParsedUnifiedDiff {
  const normalizedText = String(diffText ?? "").replace(/\r\n/g, "\n");
  const lines = normalizedText.endsWith("\n")
    ? normalizedText.slice(0, -1).split("\n")
    : normalizedText.split("\n");
  const changedLines = lines.length === 1 && lines[0] === "" ? [] : lines;
  const isAddition = lineType === "addition";

  return {
    additions: isAddition ? changedLines.length : 0,
    binary: false,
    deletions: isAddition ? 0 : changedLines.length,
    headers: [],
    hunks: changedLines.length ? [{
      complete: false,
      newCount: isAddition ? changedLines.length : 0,
      newStart: isAddition ? 1 : 0,
      oldCount: isAddition ? 0 : changedLines.length,
      oldStart: isAddition ? 0 : 1,
      header: isAddition
        ? `@@ -0,0 +1,${changedLines.length} @@`
        : `@@ -1,${changedLines.length} +0,0 @@`,
      lines: changedLines.map((line, index) => ({
        newLineNumber: isAddition ? index + 1 : null,
        oldLineNumber: isAddition ? null : index + 1,
        text: line,
        type: lineType,
      })),
    }] : [],
  };
}

function parseFileChangeDiff (change: FileUpdateChange) {
  const parsedDiff = parseUnifiedDiff(change.diff);
  // Binary diffs carry no lines; never reinterpret their headers or payload as whole-file text.
  if (parsedDiff.binary || parsedDiff.hunks.length || !change.diff.trim()) {
    return parsedDiff;
  }

  if (change.kind.type === "add") {
    return parseWholeFileTextDiff(change.diff, "addition");
  }
  if (change.kind.type === "delete") {
    return parseWholeFileTextDiff(change.diff, "deletion");
  }
  return parsedDiff;
}

function ThreadFileChangeDetails ({ parsedChange }: { parsedChange: ParsedFileChange }) {
  return (
    <div className="space-y-3">
      {parsedChange.change.workbenchAnalysis ? (
        <div className="space-y-1 text-[0.78em] leading-[1.6] text-fg/muted">
          <p className="m-0">Counts show requested changes found in the observed file, not who wrote them or untouched-file integrity.</p>
          {parsedChange.change.workbenchAnalysis.detail ? <p className="m-0">{parsedChange.change.workbenchAnalysis.detail}</p> : null}
          {parsedChange.change.workbenchAnalysis.hunks.map((hunk) => (
            <p className="m-0" key={hunk.index}>
              Hunk {hunk.index + 1}{": "}
              {hunk.outcome === "present" ? "requested changes present" : hunk.outcome === "unapplied" ? "requested changes not applied" : "uncertain"}
              {hunk.currentStart === null ? "" : ` at observed line ${hunk.currentStart}`}
              {hunk.reason ? `. ${hunk.reason}` : ""}
            </p>
          ))}
          <p className="m-0 font-medium">Attempted diff</p>
        </div>
      ) : null}
      {parsedChange.movePathDisplay ? (
        <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-fg/muted">
          <span>From</span>
          <ProjectFilePath className="max-w-full align-baseline" path={parsedChange.movePathDisplay} />
        </p>
      ) : null}
      {parsedChange.diff.binary ? (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">Binary file. No diff preview.</p>
      ) : parsedChange.diff.hunks.length || parsedChange.change.diff.trim() ? (
        <ThreadCodeDisplay diff={parsedChange.diff} preview variant="diff" />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No diff captured.</p>
      )}
    </div>
  );
}

/** `icon` leads the summary with the change's kind; step rows show it in their own icon slot instead. */
function ThreadFileChangeSummary ({
  icon = true,
  parsedChange,
}: {
  icon?: boolean;
  parsedChange: ParsedFileChange;
}) {
  const presentation = getFileChangePresentation(parsedChange.change);

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1"
      data-thread-file-change-row-mode={parsedChange.detailsAvailable ? "disclosure" : parsedChange.staticMarker ? "static" : "plain"}
    >
      {icon ? (
        <span className={`inline-flex shrink-0 self-center -mt-0.5 ${parsedChange.danger ? "text-danger" : "text-fg/muted"}`} aria-hidden="true">
          <presentation.Icon size={20} />
        </span>
      ) : null}
      <span className={parsedChange.danger ? "text-danger" : undefined}>
        <ThreadSummaryText text={parsedChange.presentationLabel ?? presentation.completedLabel} />
      </span>
      <ProjectFilePath className="max-w-full shrink min-w-0 align-baseline text-[0.82em]" path={parsedChange.displayPath} />
      {parsedChange.failedAttempts > 1 ? (
        <span className={`font-mono text-[0.78em] leading-[1.6] ${parsedChange.danger ? "text-danger" : "text-fg/muted"}`}>
          <span aria-hidden="true" className="inline-block animate-tick motion-reduce:animate-none" key={parsedChange.failedAttempts}>×{parsedChange.failedAttempts}</span>
          <span className="sr-only">{parsedChange.failedAttempts} failed attempts</span>
        </span>
      ) : null}
      {parsedChange.diff.binary ? (
        <span className="font-mono text-[0.78em] leading-[1.6] text-fg/muted">Binary</span>
      ) : (
        <ThreadFileChangeTotals
          additions={parsedChange.summaryTotals.additions}
          animateChanges
          deletions={parsedChange.summaryTotals.deletions}
        />
      )}
    </span>
  );
}

export function ThreadFileChangeList ({ changes }: { changes: ThreadFileChangeListChange[] }) {
  return (
    <div className="space-y-1.5 py-2">
      {changes.length ? (
        <ThreadFileChangeRows changes={changes} />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No changed files captured.</p>
      )}
    </div>
  );
}

/** `steps` draws each change as a work step row (kind icon, one line, tap for the diff), as the transcript's file steps do. */
function ThreadFileChangeRows ({
  animateEntries = false,
  changes,
  plainInset = true,
  steps = false,
}: {
  animateEntries?: boolean;
  changes: ThreadFileChangeListChange[];
  plainInset?: boolean;
  steps?: boolean;
}) {
  const project = useProject.contextual();
  const showPath = (path: string) => project?.displayPath(path) ?? toWorkspaceDisplayPath(path, {}) ?? path;
  const parsedChanges: ParsedFileChange[] = changes.map((entry, index) => {
    const diff = entry.diff ?? parseFileChangeDiff(entry.change);
    return {
      change: entry.change,
      danger: entry.danger ?? false,
      detailsAvailable: entry.detailsAvailable ?? true,
      diff,
      displayPath: showPath(entry.change.path),
      failedAttempts: entry.failedAttempts ?? 0,
      movePathDisplay: entry.change.kind.type === "update" && entry.change.kind.move_path ? showPath(entry.change.kind.move_path) : null,
      presentationLabel: entry.presentationLabel,
      sourceChangeIndex: entry.sourceChangeIndex ?? index,
      sourceItemId: entry.sourceItemId ?? "file-change-list",
      staticMarker: entry.staticMarker ?? false,
      summaryTotals: entry.summaryTotals ?? {
        additions: diff.additions,
        deletions: diff.deletions,
      },
    };
  });

  return parsedChanges.map((change, index) => {
    const key = `${change.sourceItemId}:change:${change.sourceChangeIndex}:${change.displayPath}:${change.movePathDisplay ?? ""}`;
    const selection = changes[index].selection;
    const content = <ThreadFileChangeSummary parsedChange={change} />;
    const summary = selection ? <WorkbenchCheckbox
      checked={selection.checked}
      className="-ml-2 -my-1 min-w-0 max-w-full !text-[1em]"
      disabled={selection.disabled}
      label={content}
      onChange={selection.onChange}
    /> : content;
    if (steps) {
      const presentation = getFileChangePresentation(change.change);
      const { editing = false, span = null } = changes[index];
      const stepSummary = <ThreadFileChangeSummary icon={false} parsedChange={editing ? { ...change, presentationLabel: presentation.inProgressLabel } : change} />;
      const iconClassName = change.danger ? "text-danger" : undefined;
      const progress: ThreadStepProgress | undefined = editing
        ? { state: "inProgress", startedAtMs: span?.startedAtMs ?? null }
        : span?.durationMs !== null && span?.durationMs !== undefined ? { state: "completed", durationMs: span.durationMs } : undefined;
      return (
        <ThreadEntryMotion enabled={animateEntries} identity={getThreadFileChangeMotionIdentity(change.sourceItemId, change.sourceChangeIndex)} key={key}>
          {(animate) => (
            <div className={animate ? `block ${enterMotionClassName}` : undefined}>
              {change.detailsAvailable ? (
                <ThreadStepRow icon={<presentation.Icon size={16} />} iconClassName={iconClassName} progress={progress} summary={stepSummary}>
                  {changes[index].showDiff !== false ? <ThreadFileChangeDetails parsedChange={change} /> : null}
                  {changes[index].details}
                </ThreadStepRow>
              ) : <ThreadStepRow icon={<presentation.Icon size={16} />} iconClassName={iconClassName} progress={progress} summary={stepSummary} />}
            </div>
          )}
        </ThreadEntryMotion>
      );
    }
    return (
      <ThreadEntryMotion enabled={animateEntries} identity={getThreadFileChangeMotionIdentity(change.sourceItemId, change.sourceChangeIndex)} key={key}>
        {(animate) => change.detailsAvailable ? (
          <Disclosure
            className={animate ? `block ${enterMotionClassName} py-0.5` : "py-0.5"}
            contentClassName="mt-2 pl-6"
            summary={summary}
            summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
          >
            {changes[index].showDiff !== false ? <ThreadFileChangeDetails parsedChange={change} /> : null}
            {changes[index].details}
          </Disclosure>
        ) : change.staticMarker ? (
          <DisclosureStaticRow
            className={animate ? `block ${enterMotionClassName} !py-0.5` : "!py-0.5"}
            markerClassName={change.danger ? "text-danger" : undefined}
            summary={summary}
            summaryClassName={`text-[0.92em] leading-[1.6] ${change.danger ? "text-danger" : "text-fg/muted"}`}
          />
        ) : (
          <div className={`${animate ? `block ${enterMotionClassName} ` : ""}py-0.5 text-[0.92em] leading-[1.6] text-fg/muted ${plainInset ? "pl-6" : ""}`}>
            {summary}
          </div>
        )}
      </ThreadEntryMotion>
    );
  });
}

export function ThreadFileChangePreviewList ({ changes }: { changes: ThreadFileChangeListChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="space-y-1.5 py-2">
      <ThreadFileChangeRows
        changes={changes.map((entry) => ({
          ...entry,
          detailsAvailable: false,
          staticMarker: false,
        }))}
        plainInset={false}
      />
    </div>
  );
}

function ThreadFileChangeOutcome ({ item }: { item: FileChangeItem }) {
  if (item.status === "completed" || item.changes.length) {
    return null;
  }

  const label = item.status === "inProgress"
    ? "Applying patch..."
    : item.status === "failed" || item.workbenchPolicy === "automaticEscalation"
      ? "Failed to apply patch"
      : "Patch declined";
  const danger = item.status === "failed" || item.status === "declined";
  return (
    <div data-thread-file-change-outcome={item.status}>
      <ThreadStepRow
        icon={item.status === "inProgress" ? <LoaderIcon /> : <FileUpdateIcon size={16} />}
        iconClassName={danger ? "text-danger" : undefined}
        summary={<span className={danger ? "text-danger" : undefined}><ThreadSummaryText text={label} /></span>}
      />
    </div>
  );
}

interface NativeFileEvidenceFacts {
  durationMs: number | null;
  failed: boolean;
  /** Distinct tool outputs explaining failures, in order; successful calls never expose their raw invocation or output. */
  failureOutputs: string[];
}

function getNativeFailureOutput(item: NativeFileItem) {
  const output = item.type === "dynamicToolCall"
    ? formatToolCallOutput({ content: item.contentItems })
    : formatToolCallOutput({ content: item.result?.content, fallback: item.error?.message ?? null });
  return output?.trim() || null;
}

function getNativeFileEvidence(items: readonly NativeFileItem[]): NativeFileEvidenceFacts | null {
  const durations = items.flatMap(item => item.durationMs === null ? [] : [item.durationMs]);
  const failedItems = items.filter(item => getNativeFileOperationOutcome(item) === "failed");
  return durations.length || failedItems.length ? {
    durationMs: durations.length ? durations.reduce((total, duration) => total + duration, 0) : null,
    failed: failedItems.length > 0,
    failureOutputs: [...new Set(failedItems.flatMap(item => getNativeFailureOutput(item) ?? []))],
  } : null;
}

function NativeFileEvidence({ evidence }: { evidence: NativeFileEvidenceFacts }) {
  return <>
    {evidence.durationMs !== null ? <ThreadDurationText durationMs={evidence.durationMs} /> : null}
    {evidence.failed ? <p className="m-0 text-fg/muted">Attempted change. Applied counts are unavailable.</p> : null}
    {evidence.failureOutputs.map(output => <ThreadCodeDisplay key={output} output={output} preview variant="plain" />)}
  </>;
}

function getNativePieceLabel({ entry, item }: StitchedNativeFilePiece) {
  return entry.presentationLabel ?? getFileChangeLifecycleLabel(entry.change, {
    status: getNativeFileOperationOutcome(item),
    workbenchFailureKind: entry.failureKind,
  });
}

function mergeParsedDiffs(diffs: ParsedUnifiedDiff[]): ParsedUnifiedDiff {
  return diffs.length === 1 ? diffs[0]! : {
    additions: diffs.reduce((total, part) => total + part.additions, 0),
    binary: diffs.some(part => part.binary),
    deletions: diffs.reduce((total, part) => total + part.deletions, 0),
    headers: diffs[0]!.headers,
    hunks: diffs.flatMap(part => part.hunks),
  };
}

/**
 * One row for back-to-back pieces, keyed by the first piece so it grows in place.
 * Applied runs accumulate counts and hunks in order; failure runs count attempts and show only the latest attempted diff.
 */
export function getStitchedNativeRowChange({ pieces }: StitchedNativeFileRow): ThreadFileChangeListChange {
  const [anchor] = pieces;
  const live = [...pieces].reverse().find(piece => getNativeFileOperationOutcome(piece.item) === "inProgress");
  const failedAttempts = pieces.filter(piece => getNativeFileOperationOutcome(piece.item) === "failed").length;
  const latestAttempt = [...pieces].reverse().find(piece => piece.entry.change.diff) ?? pieces.at(-1)!;
  const shown: StitchedNativeFileRow["pieces"] = getNativeFileOperationOutcome(anchor.item) === "failed" ? [latestAttempt] : pieces;
  const diffs = shown.map(piece => parseFileChangeDiff(piece.entry.change));
  const diff = mergeParsedDiffs(diffs);
  const summaryTotals = shown.reduce((total, piece, index) => {
    const counts = piece.entry.summaryTotals ?? diffs[index]!;
    return { additions: total.additions + counts.additions, deletions: total.deletions + counts.deletions };
  }, { additions: 0, deletions: 0 });
  const evidence = getNativeFileEvidence(pieces.filter(piece => piece.primary).map(piece => piece.item));
  const hasDiff = shown.some(piece => Boolean(piece.entry.change.diff));
  const settled = pieces.some(piece => getNativeFileOperationOutcome(piece.item) !== "inProgress");
  return {
    change: shown[0].entry.change,
    danger: (live ?? anchor).entry.danger,
    details: evidence ? <NativeFileEvidence evidence={evidence} /> : undefined,
    // Stays a disclosure while a later piece streams, so an open diff never collapses mid-growth.
    detailsAvailable: settled && (hasDiff || Boolean(evidence)),
    diff,
    failedAttempts,
    presentationLabel: getNativePieceLabel(live ?? anchor),
    showDiff: hasDiff,
    sourceChangeIndex: anchor.entry.sourceChangeIndex,
    sourceItemId: anchor.entry.sourceItemId,
    staticMarker: true,
    summaryTotals,
  };
}

/** One row for back-to-back applied changes of one kind on one file, keyed by the first so it grows in place. */
function getStitchedCanonicalRowChange({ pieces }: StitchedCanonicalFileRow): ThreadFileChangeListChange {
  const [{ change, item, sourceChangeIndex }] = pieces;
  const analysis = item.status !== "completed" && item.workbenchFailureKind !== "unclaimed" ? change.workbenchAnalysis : undefined;
  return {
    change,
    danger: analysis ? analysis.outcome !== "present" && analysis.outcome !== "copied" : item.status === "failed" || item.status === "declined",
    detailsAvailable: item.status === "completed" || Boolean(analysis),
    diff: pieces.length > 1 ? mergeParsedDiffs(pieces.map(piece => parseFileChangeDiff(piece.change))) : undefined,
    presentationLabel: getFileChangeLifecycleLabel(change, item, analysis),
    sourceChangeIndex,
    sourceItemId: item.id,
    staticMarker: true,
    summaryTotals: pieces.reduce((total, piece) => {
      const counts = getFileChangeCounts(piece.item, piece.change);
      return { additions: total.additions + counts.additions, deletions: total.deletions + counts.deletions };
    }, { additions: 0, deletions: 0 }),
  };
}

export default function ThreadFileChangeItem ({
  animateEntries = false,
  editing = false,
  itemTimeline,
  items,
  mode = "step",
}: {
  animateEntries?: boolean;
  /**
   * Nothing has followed these edits in a live turn yet: the last row is still being worked on, so repeated calls
   * on one file read as one ongoing edit until the agent moves on.
   */
  editing?: boolean;
  itemTimeline?: readonly WorkbenchThreadItemTimelineEntry[];
  items: FileOperationItem[];
  /** `status`: only the newest row, for an activity card's one-row status slot. */
  mode?: "status" | "step";
}) {
  const hasRows = items.some((item) => item.type !== "fileChange" || item.changes.length || item.status !== "completed");
  if (items.length && items.every(item => item.type !== "fileChange"
    && item.status === "inProgress" && !getNativeFileChanges(item).length)) return null;
  const groups = stitchFileOperationRows(items);
  const trailingRow = groups.at(-1)?.rows.at(-1);
  const timed = (change: ThreadFileChangeListChange, row: StitchedNativeFileRow | StitchedCanonicalFileRow): ThreadFileChangeListChange => ({
    ...change,
    editing: editing && row === trailingRow && !change.danger,
    span: getStitchedRowSpan(row.pieces.map(piece => piece.item), itemTimeline),
  });
  const shown = mode === "status" ? groups.slice(-1) : groups;
  const shownRows = <Row,>(rows: Row[]) => mode === "status" ? rows.slice(-1) : rows;
  return (
    <div className="step-rows-packed py-1.5">
      {shown.map((group) => {
        if (group.kind === "native") {
          const { item, rows } = group;
          if (rows.length) {
            return (
              <div className="space-y-0.5" key={item.id}>
                <ThreadFileChangeRows
                  animateEntries={animateEntries}
                  changes={shownRows(rows).map(row => timed(getStitchedNativeRowChange(row), row))}
                  steps
                />
              </div>
            );
          }
          const outcome = getNativeFileOperationOutcome(item);
          if (outcome === "inProgress") return null;
          const label = <ThreadSummaryText text={outcome === "failed" ? "Failed file operation" : "File operation completed"} />;
          const evidence = getNativeFileEvidence([item]);
          const icon = <FileUpdateIcon size={16} />;
          const iconClassName = outcome === "failed" ? "text-danger" : undefined;
          return (
            <div className="space-y-0.5" key={item.id}>
              {evidence ? (
                <ThreadStepRow icon={icon} iconClassName={iconClassName} summary={label}><NativeFileEvidence evidence={evidence} /></ThreadStepRow>
              ) : <ThreadStepRow icon={icon} iconClassName={iconClassName} summary={label} />}
            </div>
          );
        }
        const { item } = group;
        return (
        <div className="space-y-0.5" key={item.id}>
          <ThreadFileChangeRows
            animateEntries={animateEntries}
            changes={shownRows(group.rows).map(row => timed(getStitchedCanonicalRowChange(row), row))}
            steps
          />
          {item.workbenchRecovery?.state === "failed" ? (
            <p className="m-0 pl-6 text-[0.78em] leading-[1.6] text-danger">Recovery context could not be queued{item.workbenchRecovery.detail ? `. ${item.workbenchRecovery.detail}` : "."}</p>
          ) : null}
          <ThreadFileChangeOutcome item={item} />
        </div>
        );
      })}
      {!hasRows ? (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No changed files captured.</p>
      ) : null}
    </div>
  );
}
