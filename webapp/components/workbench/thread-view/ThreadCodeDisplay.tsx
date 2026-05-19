/*
 * Exports:
 * - default ThreadCodeDisplay: render thread code, unified diffs, and command output in one shared display. Keywords: workbench, thread, code, diff, command output.
 * - Local helpers: render unified-diff rows, plain text output rows, and expandable command headers. Keywords: diff rows, line numbers, command clamp, fade.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { ParsedUnifiedDiff, UnifiedDiffLine } from "../../../lib/workbench/thread/thread-file-diff";

type ThreadCodeDisplayProps =
  | {
    diff: ParsedUnifiedDiff;
    header?: ReactNode;
    output?: never;
    variant: "diff";
  }
  | {
    diff?: never;
    header?: ReactNode;
    output?: string;
    variant: "plain";
  };

const EDGE_FADE_CLASS = `
  relative
  before:block before:absolute before:inset-0 before:w-20 before:bg-linear-to-r before:from-[var(--bg)] before:to-transparent
  after:block after:absolute after:inset-0 after:left-auto after:w-20 after:bg-linear-to-l after:from-[var(--bg)] after:to-transparent
`;

export function ThreadCommandHeader ({ command }: { command: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <button
      aria-expanded={isExpanded}
      className={`
        ${EDGE_FADE_CLASS} block w-full cursor-pointer border-0 bg-[color-mix(in_srgb,var(--muted)_5%,transparent)] px-12 py-2
        text-left font-mono text-[0.78em] leading-[1.6] text-text hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]
        focus-visible:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] focus-visible:outline-none
      `}
      title={isExpanded ? "Collapse command" : "Show full command"}
      type="button"
      onClick={() => {
        setIsExpanded((current) => !current);
      }}
    >
      <span className={isExpanded ? "block whitespace-pre-wrap break-words" : "block truncate"}>
        {command || "No command captured."}
      </span>
    </button>
  );
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
    <div>
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
            <div className="ml-12 whitespace-pre-wrap break-words px-0 py-1 font-mono text-[0.78em] leading-[1.65] text-accent">
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
      <div className="ml-12 whitespace-pre-wrap break-words px-4 py-1.5 font-mono text-[0.78em] leading-[1.65] text-muted italic">
        {line.text}
      </div>
    );
  }

  const lineStyle = getDiffLineStyle(line.type);

  return (
    <div
      className={`
        ${EDGE_FADE_CLASS} grid px-12 font-mono tabular-nums text-[0.78em] leading-[1.65] ${lineStyle.rowClassName}
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

function ThreadPlainOutput ({ output }: { output: string }) {
  return (
    <pre
      className={`
        ${EDGE_FADE_CLASS} m-0 overflow-x-auto whitespace-pre-wrap break-words bg-[color-mix(in_srgb,var(--muted)_5%,transparent)]
        px-12 py-3 font-mono text-[0.78em] leading-[1.6] text-text
      `}
    >
      {output}
    </pre>
  );
}

export default function ThreadCodeDisplay (props: ThreadCodeDisplayProps) {
  return (
    <div className="overflow-x-auto -ml-12 -mr-4">
      {props.header}
      {props.variant === "diff" ? (
        <ThreadUnifiedDiff diff={props.diff} />
      ) : props.output ? (
        <ThreadPlainOutput output={props.output} />
      ) : (
        null
      )}
    </div>
  );
}
