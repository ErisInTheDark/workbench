/*
 * Exports:
 * - default ThreadFileChangeItem: render one or more adjacent fileChange items with per-file counts and expandable unified diffs. Keywords: workbench, thread, file change, diff.
 * - ThreadFileChangeList: render reusable file-change rows from already-shaped file update changes. Keywords: workbench, thread, file change, diff list.
 * - ThreadFileChangeTotals: render shared cumulative addition and deletion counts. Keywords: workbench, thread, file change, totals.
 * - Local helpers: format paths, summary labels, lifecycle rows, and change totals for thread file changes. Keywords: additions, deletions, status, path display.
 */
"use client";

import type { ReactNode } from "react";

import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { WorkbenchFileChangeItem } from "../../../lib/workbench/thread/workbench-file-change";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "../../../lib/workbench/thread/thread-file-diff";
import ProjectFilePath from "../ProjectFilePath";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon } from "../workbench-icons";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";

type FileChangeItem = WorkbenchFileChangeItem;
type FileUpdateChange = FileChangeItem["changes"][number];

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
        icon: <FileAddIcon className="size-5" />,
        inProgressLabel: "Creating",
      };
    case "delete":
      return {
        completedLabel: "Deleted",
        failureVerb: "delete",
        icon: <FileDeleteIcon className="size-5" />,
        inProgressLabel: "Deleting",
      };
    case "update":
      return change.kind.move_path
        ? {
          completedLabel: "Moved",
          failureVerb: "move",
          icon: <FileMoveIcon className="size-5" />,
          inProgressLabel: "Moving",
        }
        : {
          completedLabel: "Edited",
          failureVerb: "edit",
          icon: <FileUpdateIcon className="size-5" />,
          inProgressLabel: "Editing",
        };
    default:
      return assertNeverFileChangeKind(change.kind);
  }
}

function getFileChangeLifecycleLabel(change: FileUpdateChange, item: FileChangeItem) {
  const presentation = getFileChangePresentation(change);
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
      {parsedChange.movePathDisplay ? (
        <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
          <span>From</span>
          <ProjectFilePath className="max-w-full align-baseline" disambiguationPaths={projectFilePaths} path={parsedChange.movePathDisplay} projectId={projectId} />
        </p>
      ) : null}
      {parsedChange.change.diff.trim() ? (
        <ThreadCodeDisplay diff={parsedChange.diff} preview variant="diff" />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No diff captured.</p>
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
      <span className={`inline-flex shrink-0 self-center -mt-0.5 ${parsedChange.danger ? "text-danger" : "text-muted"}`} aria-hidden="true">
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
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No changed files captured.</p>
      )}
    </div>
  );
}

function ThreadFileChangeRows ({
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

  return parsedChanges.map((change) => {
    const key = `${change.sourceItemId}:change:${change.displayPath}:${change.movePathDisplay ?? ""}`;
    const summary = <ThreadFileChangeSummary parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />;
    return change.detailsAvailable ? (
      <ThreadDisclosure
        key={key}
        className="py-0.5"
        contentClassName="mt-2 pl-6"
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      >
        <ThreadFileChangeDetails parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />
      </ThreadDisclosure>
    ) : change.staticMarker ? (
      <ThreadDisclosureStaticRow
        key={key}
        className="!py-0.5"
        markerClassName={change.danger ? "text-danger" : undefined}
        summary={summary}
        summaryClassName={`text-[0.92em] leading-[1.6] ${change.danger ? "text-danger" : "text-muted"}`}
      />
    ) : (
      <div key={key} className="py-0.5 pl-6 text-[0.92em] leading-[1.6] text-muted">
        {summary}
      </div>
    );
  });
}

function ThreadFileChangeOutcome ({ item }: { item: FileChangeItem }) {
  if (item.status === "completed" || item.changes.length) {
    return null;
  }

  const label = item.status === "inProgress"
    ? "Applying patch..."
    : item.status === "failed"
      ? "Failed to apply patch"
      : "Patch declined";
  const danger = item.status === "failed" || item.status === "declined";
  return (
    <div data-thread-file-change-outcome={item.status}>
      <ThreadDisclosureStaticRow
        className="!py-0.5"
        markerClassName={danger ? "text-danger" : undefined}
        summary={<ThreadSummaryText text={label} />}
        summaryClassName={`text-[0.92em] leading-[1.6] ${danger ? "text-danger" : "text-muted"}`}
      />
    </div>
  );
}

export default function ThreadFileChangeItem ({
  items,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
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
            changes={item.changes.map((change, sourceChangeIndex) => ({
              change,
              danger: item.status === "failed" || item.status === "declined",
              detailsAvailable: item.status === "completed",
              presentationLabel: getFileChangeLifecycleLabel(change, item),
              sourceChangeIndex,
              sourceItemId: item.id,
              staticMarker: true,
              summaryTotals: change.workbenchAdditions !== undefined || change.workbenchDeletions !== undefined
                ? {
                  additions: change.workbenchAdditions ?? 0,
                  deletions: change.workbenchDeletions ?? 0,
                }
                : undefined,
            }))}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            workspaceRoots={workspaceRoots}
          />
          <ThreadFileChangeOutcome item={item} />
        </div>
      ))}
      {!hasRows ? (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No changed files captured.</p>
      ) : null}
    </div>
  );
}
