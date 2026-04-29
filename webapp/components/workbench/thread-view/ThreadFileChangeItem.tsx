/*
 * Exports:
 * - default ThreadFileChangeItem: render one or more adjacent fileChange items with per-file counts and expandable unified diffs. Keywords: workbench, thread, file change, diff.
 * - Local helpers: format paths, totals, and unified-diff rows for thread file changes. Keywords: unified diff, additions, deletions, path display.
 */
"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { toWorkbenchDisplayPath } from "../../../lib/workbench/markdown/markdown-links";
import {
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
  type UnifiedDiffLine,
} from "../../../lib/workbench/thread/thread-file-diff";
import ProjectFilePath from "../ProjectFilePath";
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

function getChangeKindLabel (change: FileUpdateChange) {
  switch (change.kind.type) {
    case "add":
      return "Added";
    case "delete":
      return "Deleted";
    case "update":
      return change.kind.move_path ? "Moved" : "Updated";
    default:
      return "Changed";
  }
}

function ThreadUnifiedDiff ({
  diff,
}: {
  diff: ParsedUnifiedDiff;
}) {
  const lineNumberWidth = Math.max(
    2,
    ...diff.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => [
      line.oldLineNumber ? String(line.oldLineNumber).length : 0,
      line.newLineNumber ? String(line.newLineNumber).length : 0,
    ])),
  );

  return (
    <div className="overflow-x-auto -ml-12 -mr-4">
      {diff.headers.length ? (
        <div className="px-0 py-2 font-mono text-[0.78em] leading-[1.65] text-muted">
          {diff.headers.map((line, index) => (
            <div key={`header:${index}`} className="whitespace-pre-wrap break-words">
              {line || " "}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        {diff.hunks.map((hunk, hunkIndex) => (
          <div key={`hunk:${hunkIndex}`} className={hunkIndex ? "pt-3" : ""}>
            <div className="whitespace-pre-wrap break-words px-0 py-1 ml-12 font-mono text-[0.78em] leading-[1.65] text-accent">
              {hunk.header}
            </div>
            <div>
              {hunk.lines.map((line, lineIndex) => (
                <ThreadUnifiedDiffLine
                  key={`line:${hunkIndex}:${lineIndex}`}
                  line={line}
                  lineNumberWidth={lineNumberWidth}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThreadUnifiedDiffLine ({
  line,
  lineNumberWidth,
}: {
  line: UnifiedDiffLine;
  lineNumberWidth: number;
}) {
  if (line.type === "note") {
    return (
      <div className="whitespace-pre-wrap break-words px-4 py-1.5 ml-12 font-mono text-[0.78em] leading-[1.65] text-muted italic">
        {line.text}
      </div>
    );
  }

  const lineStyle = getDiffLineStyle(line.type);

  return (
    <div
      className={`
        px-12 grid font-mono tabular-nums text-[0.78em] leading-[1.65] ${lineStyle.rowClassName} relative 
        before:block before:absolute before:inset-0 before:w-20 before:bg-linear-to-r before:from-[var(--bg)] before:to-transparent
        after:block after:absolute after:inset-0 after:left-auto after:w-20 after:bg-linear-to-l after:from-[var(--bg)] after:to-transparent
      `}
      style={{ gridTemplateColumns: `${lineNumberWidth + 4}ch ${lineNumberWidth + 4}ch 3rem minmax(0,1fr)` }}
    >
      <span className={`px-3 py-1 text-right ${lineStyle.gutterTextClassName}`}>
        {line.oldLineNumber ?? ""}
      </span>
      <span className={`px-3 py-1 text-right ${lineStyle.gutterTextClassName}`}>
        {line.newLineNumber ?? ""}
      </span>
      <span className={`px-3 py-1 text-center ${lineStyle.prefixClassName}`}>
        {lineStyle.prefix}
      </span>
      <span className={`whitespace-pre-wrap break-words px-3 py-1 ${lineStyle.contentClassName}`}>
        {line.text || " "}
      </span>
    </div>
  );
}

function getDiffLineStyle (type: UnifiedDiffLine["type"]) {
  switch (type) {
    case "addition":
      return {
        contentClassName: "text-text",
        gutterTextClassName: "text-[color:color-mix(in_srgb,var(--success)_70%,var(--text)_30%)]",
        prefix: "+",
        prefixClassName: "text-[color:color-mix(in_srgb,var(--success)_82%,var(--text)_18%)]",
        rowClassName: "bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
      };
    case "deletion":
      return {
        contentClassName: "text-text",
        gutterTextClassName: "text-[color:color-mix(in_srgb,var(--danger)_70%,var(--text)_30%)]",
        prefix: "-",
        prefixClassName: "text-[color:color-mix(in_srgb,var(--danger)_82%,var(--text)_18%)]",
        rowClassName: "bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]",
      };
    case "context":
    default:
      return {
        contentClassName: "text-text",
        gutterTextClassName: "text-muted",
        prefix: "\u00a0",
        prefixClassName: "text-muted",
        rowClassName: "bg-[color-mix(in_srgb,var(--muted)_5%,transparent)]",
      };
  }
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
          {getChangeKindLabel(parsedChange.change)} file
        </p>
        {parsedChange.movePathDisplay ? (
          <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
            <span>From</span>
            <ProjectFilePath className="max-w-full align-baseline" path={parsedChange.movePathDisplay} />
          </p>
        ) : null}
      </div>
      {parsedChange.change.diff.trim() ? (
        <ThreadUnifiedDiff diff={parsedChange.diff} />
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
    diff: parseUnifiedDiff(change.diff),
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
              <ThreadSummaryText text="Changed" />
              <ProjectFilePath className="max-w-full shrink min-w-0 align-baseline text-[0.82em]" path={change.displayPath} />
              <DiffChangeTotals additions={change.diff.additions} deletions={change.diff.deletions} />
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
