/*
 * Exports:
 * - default ThreadFileChangeItem: render one or more adjacent fileChange items with per-file counts and expandable unified diffs.
 * - ThreadFileChangeList: render reusable file-change rows from already-shaped file update changes.
 * - ThreadFileChangePreviewList: render non-disclosure file-change previews with established row presentation.
 * - ThreadFileChangeTotals: render shared cumulative addition and deletion counts.
 * - ThreadFileChangeListChange: reusable file-change row input.
 * - getThreadFileChangeTotals: cumulative counts using the same precedence as file rows.
 */
"use client";

import type { ReactNode } from "react";

import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import type { FileChangeAnalysis } from "workbench-shared/workbench/thread/file-change-analysis";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "workbench-shared/workbench/thread/unified-diff";
import ProjectFilePath from "../ProjectFilePath";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon } from "../workbench-icons";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";

type FileChangeItem = WorkbenchFileChangeItem;
type FileUpdateChange = FileChangeItem["changes"][number];

export function getThreadFileChangeTotals(items: readonly FileChangeItem[]) {
  return items.reduce((total, item) => {
    for (const change of item.changes) {
      const counts = getFileChangeCounts(item, change);
      total.additions += counts.additions;
      total.deletions += counts.deletions;
    }
    return total;
  }, { additions: 0, deletions: 0 });
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
  movePathDisplay: string | null;
  presentationLabel?: string;
  sourceChangeIndex: number;
  sourceItemId: string;
  staticMarker: boolean;
  summaryTotals: { additions: number; deletions: number };
}

export interface ThreadFileChangeListChange {
  change: FileUpdateChange;
  danger?: boolean;
  detailsAvailable?: boolean;
  presentationLabel?: string;
  sourceChangeIndex?: number;
  sourceItemId?: string;
  staticMarker?: boolean;
  summaryTotals?: { additions: number; deletions: number };
  selection?: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void };
}

interface FileChangePresentation {
  completedLabel: string;
  failureVerb: string;
  icon: ReactNode;
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

  return (
    <span className="inline-flex items-baseline gap-2 font-mono text-[0.78em] leading-[1.6]">
      {additions ? (
        <span
          className={`${animateChanges ? "thread-file-change-total-tick " : ""}text-[color:color-mix(in_srgb,var(--success)_78%,var(--text)_22%)]`}
          key={animateChanges ? `additions-${additions}` : "additions"}
        >
          +{additions}
        </span>
      ) : null}
      {deletions ? (
        <span
          className={`${animateChanges ? "thread-file-change-total-tick " : ""}text-[color:color-mix(in_srgb,var(--danger)_78%,var(--text)_22%)]`}
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
        icon: <FileAddIcon size={20} />,
        inProgressLabel: "Creating",
      };
    case "delete":
      return {
        completedLabel: "Deleted",
        failureVerb: "delete",
        icon: <FileDeleteIcon size={20} />,
        inProgressLabel: "Deleting",
      };
    case "update":
      return change.kind.move_path
        ? {
          completedLabel: "Moved",
          failureVerb: "move",
          icon: <FileMoveIcon size={20} />,
          inProgressLabel: "Moving",
        }
        : {
          completedLabel: "Edited",
          failureVerb: "edit",
          icon: <FileUpdateIcon size={20} />,
          inProgressLabel: "Editing",
        };
    default:
      return assertNeverFileChangeKind(change.kind);
  }
}

function getFileChangeLifecycleLabel(change: FileUpdateChange, item: FileChangeItem, analysis?: FileChangeAnalysis) {
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
  if (parsedDiff.hunks.length || !change.diff.trim()) {
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

function ThreadFileChangeDetails ({
  parsedChange,
  projectFilePaths,
  projectId,
}: {
  parsedChange: ParsedFileChange;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
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
          <ProjectFilePath className="max-w-full align-baseline" disambiguationPaths={projectFilePaths} path={parsedChange.movePathDisplay} projectId={projectId} />
        </p>
      ) : null}
      {parsedChange.change.diff.trim() ? (
        <ThreadCodeDisplay diff={parsedChange.diff} preview variant="diff" />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No diff captured.</p>
      )}
    </div>
  );
}

function ThreadFileChangeSummary ({
  parsedChange,
  projectFilePaths,
  projectId,
}: {
  parsedChange: ParsedFileChange;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
  const presentation = getFileChangePresentation(parsedChange.change);

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1"
      data-thread-file-change-row-mode={parsedChange.detailsAvailable ? "disclosure" : parsedChange.staticMarker ? "static" : "plain"}
    >
      <span className={`inline-flex shrink-0 self-center -mt-0.5 ${parsedChange.danger ? "text-danger" : "text-fg/muted"}`} aria-hidden="true">
        {presentation.icon}
      </span>
      <span className={parsedChange.danger ? "text-danger" : undefined}>
        <ThreadSummaryText text={parsedChange.presentationLabel ?? presentation.completedLabel} />
      </span>
      <ProjectFilePath className="max-w-full shrink min-w-0 align-baseline text-[0.82em]" disambiguationPaths={projectFilePaths} path={parsedChange.displayPath} projectId={projectId} />
      <ThreadFileChangeTotals
        additions={parsedChange.summaryTotals.additions}
        animateChanges
        deletions={parsedChange.summaryTotals.deletions}
      />
    </span>
  );
}

export function ThreadFileChangeList ({
  changes,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  changes: ThreadFileChangeListChange[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <div className="space-y-1.5 py-2">
      {changes.length ? (
        <ThreadFileChangeRows
          changes={changes}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No changed files captured.</p>
      )}
    </div>
  );
}

function ThreadFileChangeRows ({
  animateEntries = false,
  changes,
  plainInset = true,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  animateEntries?: boolean;
  changes: ThreadFileChangeListChange[];
  plainInset?: boolean;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const parsedChanges: ParsedFileChange[] = changes.map((entry, index) => {
    const diff = parseFileChangeDiff(entry.change);
    return {
      change: entry.change,
      danger: entry.danger ?? false,
      detailsAvailable: entry.detailsAvailable ?? true,
      diff,
      displayPath: toWorkspaceDisplayPath(entry.change.path, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? entry.change.path,
      movePathDisplay: entry.change.kind.type === "update" && entry.change.kind.move_path
        ? toWorkspaceDisplayPath(entry.change.kind.move_path, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? entry.change.kind.move_path
        : null,
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
    const key = `${change.sourceItemId}:change:${change.displayPath}:${change.movePathDisplay ?? ""}`;
    const selection = changes[index].selection;
    const content = <ThreadFileChangeSummary parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />;
    const summary = selection ? <WorkbenchCheckbox
      checked={selection.checked}
      className="-ml-2 -my-1 min-w-0 max-w-full !text-[1em]"
      disabled={selection.disabled}
      label={content}
      onChange={selection.onChange}
    /> : content;
    return change.detailsAvailable ? (
      <ThreadDisclosure
        key={key}
        className={animateEntries ? "thread-file-change-enter py-0.5" : "py-0.5"}
        contentClassName="mt-2 pl-6"
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      >
        <ThreadFileChangeDetails parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />
      </ThreadDisclosure>
    ) : change.staticMarker ? (
      <ThreadDisclosureStaticRow
        key={key}
        className={animateEntries ? "thread-file-change-enter !py-0.5" : "!py-0.5"}
        markerClassName={change.danger ? "text-danger" : undefined}
        summary={summary}
        summaryClassName={`text-[0.92em] leading-[1.6] ${change.danger ? "text-danger" : "text-fg/muted"}`}
      />
    ) : (
      <div key={key} className={`${animateEntries ? "thread-file-change-enter " : ""}py-0.5 text-[0.92em] leading-[1.6] text-fg/muted ${plainInset ? "pl-6" : ""}`}>
        {summary}
      </div>
    );
  });
}

export function ThreadFileChangePreviewList ({
  changes,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  changes: ThreadFileChangeListChange[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
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
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
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
      <ThreadDisclosureStaticRow
        className="!py-0.5"
        markerClassName={danger ? "text-danger" : undefined}
        summary={<ThreadSummaryText text={label} />}
        summaryClassName={`text-[0.92em] leading-[1.6] ${danger ? "text-danger" : "text-fg/muted"}`}
      />
    </div>
  );
}

export default function ThreadFileChangeItem ({
  animateEntries = false,
  items,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  animateEntries?: boolean;
  items: FileChangeItem[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const hasRows = items.some((item) => item.changes.length || item.status !== "completed");
  return (
    <div className="space-y-1.5 py-2">
      {items.map((item) => (
        <div className="space-y-0.5" key={item.id}>
          <ThreadFileChangeRows
            animateEntries={animateEntries}
            changes={item.changes.map((change, sourceChangeIndex) => {
              const analysis = item.status !== "completed" && item.workbenchFailureKind !== "unclaimed" ? change.workbenchAnalysis : undefined;
              return {
                change,
                danger: analysis ? analysis.outcome !== "present" && analysis.outcome !== "copied" : item.status === "failed" || item.status === "declined",
                detailsAvailable: item.status === "completed" || Boolean(analysis),
                presentationLabel: getFileChangeLifecycleLabel(change, item, analysis),
                sourceChangeIndex,
                sourceItemId: item.id,
                staticMarker: true,
                summaryTotals: getFileChangeCounts(item, change),
              };
            })}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
          {item.workbenchRecovery?.state === "failed" ? (
            <p className="m-0 pl-6 text-[0.78em] leading-[1.6] text-danger">Recovery context could not be queued{item.workbenchRecovery.detail ? `. ${item.workbenchRecovery.detail}` : "."}</p>
          ) : null}
          <ThreadFileChangeOutcome item={item} />
        </div>
      ))}
      {!hasRows ? (
        <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No changed files captured.</p>
      ) : null}
    </div>
  );
}
