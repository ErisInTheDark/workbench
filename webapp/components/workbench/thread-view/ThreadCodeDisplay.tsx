/*
 * Exports:
 * - default ThreadCodeDisplay: render thread code, unified diffs, and command output in one shared display. Keywords: workbench, thread, code, diff, command output.
 * - Local helpers: render unified-diff rows, plain text output rows, and expandable command headers. Keywords: diff rows, line numbers, command clamp, fade.
 */
"use client";

import { Fragment, useState, type CSSProperties, type ReactNode } from "react";

import type { ParsedUnifiedDiff, UnifiedDiffLine } from "../../../lib/workbench/thread/thread-file-diff";
import ThreadAnsiOutput from "./ThreadAnsiOutput";
import ThreadPreviewFrame from "./ThreadPreviewFrame";

type ThreadCodeDisplayProps =
  | {
    diff: ParsedUnifiedDiff;
    header?: ReactNode;
    output?: never;
    preview?: boolean;
    previewHeight?: string;
    variant: "diff";
  }
  | {
    diff?: never;
    header?: ReactNode;
    output?: string;
    preview?: boolean;
    previewHeight?: string;
    variant: "plain";
  };

type ThreadCodeDisplaySurface = "default" | "framed";

type ThreadCodeGradientStyle = CSSProperties;
const CODE_SURFACE_BACKGROUND = "color-mix(in srgb, var(--muted) 5%, transparent)";
const EDGE_GRADIENT_WIDTH_PX = 80;

function createEdgeGradientStyle(rowBackground: string): ThreadCodeGradientStyle {
  return {
    background: `linear-gradient(to right, transparent 0, ${rowBackground} ${EDGE_GRADIENT_WIDTH_PX}px, ${rowBackground} calc(100% - ${EDGE_GRADIENT_WIDTH_PX}px), transparent 100%)`,
  };
}

const CODE_SURFACE_EDGE_STYLE = createEdgeGradientStyle(CODE_SURFACE_BACKGROUND);

export function ThreadCommandHeader ({
  command,
  surface = "default",
}: {
  command: string;
  surface?: ThreadCodeDisplaySurface;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isFramed = surface === "framed";

  return (
    <button
      aria-expanded={isExpanded}
      className={`
        block w-full cursor-pointer border-0 ${isFramed ? "bg-transparent" : ""} px-4 py-2 md:px-12
        text-left font-mono text-[0.78em] leading-[1.6] text-text hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]
        focus-visible:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] focus-visible:outline-none
      `}
      style={isFramed ? undefined : CODE_SURFACE_EDGE_STYLE}
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
  surface = "default",
}: {
  diff: ParsedUnifiedDiff;
  surface?: ThreadCodeDisplaySurface;
}) {
  const isFramed = surface === "framed";
  const contentColumn = isFramed ? "minmax(min-content,1fr)" : "max-content";
  const lineNumberWidth = Math.max(
    2,
    ...diff.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => [
      line.oldLineNumber ? String(line.oldLineNumber).length : 0,
      line.newLineNumber ? String(line.newLineNumber).length : 0,
    ])),
  );

  return (
    <div
      className="grid w-max min-w-full"
      style={{ gridTemplateColumns: `${lineNumberWidth + 4}ch ${lineNumberWidth + 4}ch 3rem ${contentColumn}` }}
    >
      {diff.headers.length ? (
        <div className="col-span-4 px-0 py-2 font-mono text-[0.78em] leading-[1.65] text-muted">
          {diff.headers.map((line, index) => (
            <div key={`header:${index}`} className="whitespace-pre">
              {line || " "}
            </div>
          ))}
        </div>
      ) : null}
      {diff.hunks.map((hunk, hunkIndex) => (
        <Fragment key={`hunk:${hunkIndex}`}>
          <div
            className={`col-span-4 ml-4 whitespace-pre px-0 py-1 font-mono text-[0.78em] leading-[1.65] text-accent md:ml-12${hunkIndex ? " pt-4" : ""}`}
          >
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <ThreadUnifiedDiffLine
              key={`line:${hunkIndex}:${lineIndex}`}
              line={line}
              surface={surface}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function ThreadUnifiedDiffLine ({
  line,
  surface = "default",
}: {
  line: UnifiedDiffLine;
  surface?: ThreadCodeDisplaySurface;
}) {
  if (line.type === "note") {
    return (
      <div className="col-span-4 ml-4 whitespace-pre px-4 py-1.5 font-mono text-[0.78em] leading-[1.65] text-muted italic md:ml-12">
        {line.text}
      </div>
    );
  }

  const lineStyle = getDiffLineStyle(line.type);
  const edgeStyle = surface === "framed" && line.type === "context" ? undefined : lineStyle.edgeStyle;

  return (
    <div
      className={`
        col-span-4 grid grid-cols-subgrid px-4 font-mono tabular-nums text-[0.78em] leading-[1.65] md:px-12 ${getDiffRowClassName(lineStyle.rowClassName, line.type, surface)}
      `}
      style={edgeStyle}
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
      <span className={`whitespace-pre px-3 py-1 ${lineStyle.contentClassName}`}>
        {line.text || " "}
      </span>
    </div>
  );
}

function getDiffRowClassName (
  rowClassName: string,
  type: UnifiedDiffLine["type"],
  surface: ThreadCodeDisplaySurface,
) {
  if (surface !== "framed" || type !== "context") {
    return rowClassName;
  }

    return "";
}

function getDiffLineStyle (type: UnifiedDiffLine["type"]) {
  switch (type) {
    case "addition":
      return {
        contentClassName: "text-text",
        edgeStyle: createEdgeGradientStyle("color-mix(in srgb, var(--success) 10%, transparent)"),
        gutterTextClassName: "text-[color:color-mix(in_srgb,var(--success)_70%,var(--text)_30%)]",
        prefix: "+",
        prefixClassName: "text-[color:color-mix(in_srgb,var(--success)_82%,var(--text)_18%)]",
        rowClassName: "",
      };
    case "deletion":
      return {
        contentClassName: "text-text",
        edgeStyle: createEdgeGradientStyle("color-mix(in srgb, var(--danger) 10%, transparent)"),
        gutterTextClassName: "text-[color:color-mix(in_srgb,var(--danger)_70%,var(--text)_30%)]",
        prefix: "-",
        prefixClassName: "text-[color:color-mix(in_srgb,var(--danger)_82%,var(--text)_18%)]",
        rowClassName: "",
      };
    case "context":
    default:
      return {
        contentClassName: "text-text",
        edgeStyle: CODE_SURFACE_EDGE_STYLE,
        gutterTextClassName: "text-muted",
        prefix: "\u00a0",
        prefixClassName: "text-muted",
        rowClassName: "",
      };
  }
}

function ThreadPlainOutput ({
  output,
  surface = "default",
}: {
  output: string;
  surface?: ThreadCodeDisplaySurface;
}) {
  const isFramed = surface === "framed";

  return (
    <pre
      className={`
        m-0 overflow-x-auto whitespace-pre ${isFramed ? "bg-transparent" : ""}
        px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text md:px-12
      `}
      style={isFramed ? undefined : CODE_SURFACE_EDGE_STYLE}
    >
      <ThreadAnsiOutput output={output} />
    </pre>
  );
}

export default function ThreadCodeDisplay (props: ThreadCodeDisplayProps) {
  const surface: ThreadCodeDisplaySurface = props.preview ? "framed" : "default";
  const content = props.variant === "diff" ? (
    <ThreadUnifiedDiff diff={props.diff} surface={surface} />
  ) : props.output ? (
    <ThreadPlainOutput output={props.output} surface={surface} />
  ) : null;

  if (props.preview && (content || props.header)) {
    return (
      <ThreadPreviewFrame contentPadding="none" height={props.previewHeight ?? "24rem"}>
        <div className="max-w-full overflow-x-auto">
          {props.header}
          {content}
        </div>
      </ThreadPreviewFrame>
    );
  }

  return (
    <div className="max-w-full overflow-x-auto md:-ml-12 md:-mr-4">
      {props.header}
      {content}
    </div>
  );
}
