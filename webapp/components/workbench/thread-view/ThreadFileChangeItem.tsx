/*
 * Exports:
 * - default ThreadFileChangeItem: render one or more adjacent fileChange items with per-file counts and expandable unified diffs. Keywords: workbench, thread, file change, diff.
 * - ThreadFileChangeList: render reusable file-change rows from already-shaped file update changes. Keywords: workbench, thread, file change, diff list.
 * - Local helpers: format paths, summary labels, and change totals for thread file changes. Keywords: additions, deletions, path display.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "../../../lib/workbench/thread/thread-file-diff";
import ProjectFilePath from "../ProjectFilePath";
import { FileAddIcon, FileDeleteIcon, FileMoveIcon, FileUpdateIcon } from "../workbench-icons";
import ThreadCodeDisplay from "./ThreadCodeDisplay";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";

type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type FileUpdateChange = FileChangeItem["changes"][number];

interface ParsedFileChange {
  change: FileUpdateChange;
  diff: ParsedUnifiedDiff;
  displayPath: string;
  movePathDisplay: string | null;
  sourceChangeIndex: number;
  sourceItemId: string;
}

export interface ThreadFileChangeListChange {
  change: FileUpdateChange;
  sourceChangeIndex?: number;
  sourceItemId?: string;
}

interface FileChangePresentation {
  icon: ReactNode;
  label: string;
}

function assertNeverFileChangeKind (kind: never): never {
  throw new Error(`Unsupported file change kind: ${JSON.stringify(kind)}`);
}

function DiffChangeTotals ({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (!additions && !deletions) {
    return null;
  }

  return (
    <span className="inline-flex items-baseline gap-2 font-mono text-[0.78em] leading-[1.6]">
      {additions ? (
        <span className="text-[color:color-mix(in_srgb,var(--success)_78%,var(--text)_22%)]">
          +{additions}
        </span>
      ) : null}
      {deletions ? (
        <span className="text-[color:color-mix(in_srgb,var(--danger)_78%,var(--text)_22%)]">
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
        icon: <FileAddIcon className="size-5" />,
        label: "Created",
      };
    case "delete":
      return {
        icon: <FileDeleteIcon className="size-5" />,
        label: "Deleted",
      };
    case "update":
      return change.kind.move_path
        ? {
          icon: <FileMoveIcon className="size-5" />,
          label: "Moved",
        }
        : {
          icon: <FileUpdateIcon className="size-5" />,
          label: "Edited",
        };
    default:
      return assertNeverFileChangeKind(change.kind);
  }
}

function parseAddedFileTextDiff (diffText: string): ParsedUnifiedDiff {
  const normalizedText = String(diffText ?? "").replace(/\r\n/g, "\n");
  const lines = normalizedText.endsWith("\n")
    ? normalizedText.slice(0, -1).split("\n")
    : normalizedText.split("\n");
  const additionLines = lines.length === 1 && lines[0] === "" ? [] : lines;

  return {
    additions: additionLines.length,
    deletions: 0,
    headers: [],
    hunks: additionLines.length ? [{
      header: `@@ -0,0 +1,${additionLines.length} @@`,
      lines: additionLines.map((line, index) => ({
        newLineNumber: index + 1,
        oldLineNumber: null,
        text: line,
        type: "addition",
      })),
    }] : [],
  };
}

function parseFileChangeDiff (change: FileUpdateChange) {
  const parsedDiff = parseUnifiedDiff(change.diff);
  if (change.kind.type !== "add" || parsedDiff.hunks.length || !change.diff.trim()) {
    return parsedDiff;
  }

  return parseAddedFileTextDiff(change.diff);
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
  const presentation = getFileChangePresentation(parsedChange.change);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
          {presentation.label} file
        </p>
        {parsedChange.movePathDisplay ? (
          <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
            <span>From</span>
            <ProjectFilePath className="max-w-full align-baseline" disambiguationPaths={projectFilePaths} path={parsedChange.movePathDisplay} projectId={projectId} />
          </p>
        ) : null}
      </div>
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
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="inline-flex shrink-0 self-center text-muted -mt-0.5" aria-hidden="true">
        {presentation.icon}
      </span>
      <ThreadSummaryText text={presentation.label} />
      <ProjectFilePath className="max-w-full shrink min-w-0 align-baseline text-[0.82em]" disambiguationPaths={projectFilePaths} path={parsedChange.displayPath} projectId={projectId} />
      <DiffChangeTotals
        additions={parsedChange.diff.additions}
        deletions={parsedChange.diff.deletions}
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
  const parsedChanges: ParsedFileChange[] = changes.map((entry, index) => ({
    change: entry.change,
    diff: parseFileChangeDiff(entry.change),
    displayPath: toWorkspaceDisplayPath(entry.change.path, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? entry.change.path,
    movePathDisplay: entry.change.kind.type === "update" && entry.change.kind.move_path
      ? toWorkspaceDisplayPath(entry.change.kind.move_path, { projectRootPath: projectRootPath ?? "", workspaceRoots }) ?? entry.change.kind.move_path
      : null,
    sourceChangeIndex: entry.sourceChangeIndex ?? index,
    sourceItemId: entry.sourceItemId ?? "file-change-list",
  }));

  return (
    <div className="space-y-1.5 py-2">
      {parsedChanges.length ? parsedChanges.map((change, index) => (
        <ThreadDisclosure
          key={`${change.sourceItemId}:change:${change.sourceChangeIndex}:${change.change.path}:${index}`}
          className="py-0.5"
          contentClassName="mt-2 pl-6"
          summary={(
            <ThreadFileChangeSummary parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />
          )}
          summaryClassName="text-[0.92em] leading-[1.6] text-muted"
        >
          <ThreadFileChangeDetails parsedChange={change} projectFilePaths={projectFilePaths} projectId={projectId} />
        </ThreadDisclosure>
      )) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No changed files captured.</p>
      )}
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
  return (
    <ThreadFileChangeList
      changes={items.flatMap((item) => item.changes.map((change, sourceChangeIndex) => ({
        change,
        sourceChangeIndex,
        sourceItemId: item.id,
      })))}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
    />
  );
}
