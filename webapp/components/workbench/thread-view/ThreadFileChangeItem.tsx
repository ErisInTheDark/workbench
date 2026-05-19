/*
 * Exports:
 * - default ThreadFileChangeItem: render one or more adjacent fileChange items with per-file counts and expandable unified diffs. Keywords: workbench, thread, file change, diff.
 * - Local helpers: format paths, summary labels, and change totals for thread file changes. Keywords: additions, deletions, path display.
 */
"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { toWorkbenchDisplayPath } from "../../../lib/workbench/markdown/markdown-links";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "../../../lib/workbench/thread/thread-file-diff";
import ProjectFilePath from "../ProjectFilePath";
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

function DiffChangeTotals ({
  additions,
  deletions,
  isCreated,
}: {
  additions: number;
  deletions: number;
  isCreated: boolean;
}) {
  if (!additions && !deletions) {
    return null;
  }

  if (isCreated) {
    return (
      <span className="inline-flex items-baseline gap-2 font-mono text-[0.78em] leading-[1.6]">
        <span className="text-[color:color-mix(in_srgb,var(--success)_78%,var(--text)_22%)]">
          +{additions}
        </span>
        <span className="text-muted">
          {additions === 1 ? "1 added line" : `${additions} added lines`}
        </span>
      </span>
    );
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

function getChangeDetailsLabel (change: FileUpdateChange) {
  switch (change.kind.type) {
    case "add":
      return "Created";
    case "delete":
      return "Deleted";
    case "update":
      return change.kind.move_path ? "Moved" : "Updated";
    default:
      return "Changed";
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
}: {
  parsedChange: ParsedFileChange;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
          {getChangeDetailsLabel(parsedChange.change)} file
        </p>
        {parsedChange.movePathDisplay ? (
          <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
            <span>From</span>
            <ProjectFilePath className="max-w-full align-baseline" path={parsedChange.movePathDisplay} />
          </p>
        ) : null}
      </div>
      {parsedChange.change.diff.trim() ? (
        <ThreadCodeDisplay diff={parsedChange.diff} variant="diff" />
      ) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No diff captured.</p>
      )}
    </div>
  );
}

export default function ThreadFileChangeItem ({
  items,
  projectRootPath,
}: {
  items: FileChangeItem[];
  projectRootPath?: string;
}) {
  const parsedChanges: ParsedFileChange[] = items.flatMap((item) => item.changes.map((change, sourceChangeIndex) => ({
    change,
    diff: parseFileChangeDiff(change),
    displayPath: toWorkbenchDisplayPath(change.path, projectRootPath ?? "") ?? change.path,
    movePathDisplay: change.kind.type === "update" && change.kind.move_path
      ? toWorkbenchDisplayPath(change.kind.move_path, projectRootPath ?? "") ?? change.kind.move_path
      : null,
    sourceChangeIndex,
    sourceItemId: item.id,
  })));

  return (
    <div className="space-y-1.5 py-2">
      {parsedChanges.length ? parsedChanges.map((change, index) => (
        <ThreadDisclosure
          key={`${change.sourceItemId}:change:${change.sourceChangeIndex}:${change.change.path}:${index}`}
          className="py-0.5"
          contentClassName="mt-2 pl-6"
          summary={(
            <span className="inline-flex min-w-0 max-w-full items-baseline gap-3">
              <ThreadSummaryText text={change.change.kind.type === "add" ? "Created" : "Changed"} />
              <ProjectFilePath className="max-w-full shrink min-w-0 align-baseline text-[0.82em]" path={change.displayPath} />
              <DiffChangeTotals
                additions={change.diff.additions}
                deletions={change.diff.deletions}
                isCreated={change.change.kind.type === "add"}
              />
            </span>
          )}
          summaryClassName="text-[0.92em] leading-[1.6] text-muted"
        >
          <ThreadFileChangeDetails parsedChange={change} />
        </ThreadDisclosure>
      )) : (
        <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No changed files captured.</p>
      )}
    </div>
  );
}
