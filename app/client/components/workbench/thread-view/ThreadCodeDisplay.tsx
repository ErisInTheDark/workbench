/*
 * Exports:
 * - default ThreadCodeDisplay: render code, unified diffs and output with fixed or content-sized previews.
 * - ThreadCommandHeader: render expandable command headers.
 */
"use client";

import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { describeUnifiedDiff } from "workbench-shared/workbench/git/working-tree-selection";
import { compactCommandOutput } from "workbench-shared/workbench/thread/thread-command-output";
import type { ParsedUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import WorkbenchDiffLines from "../diff/WorkbenchDiffLines";
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
const CODE_SURFACE_BACKGROUND = "color-mix(in srgb, var(--text) calc(var(--muted-strength) * 0.05), transparent)";
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

/** Thread diffs share the git review renderer, so both read the same rows, highlighting and change marks. */
function ThreadUnifiedDiff ({
  diff,
  surface = "default",
}: {
  diff: ParsedUnifiedDiff;
  surface?: ThreadCodeDisplaySurface;
}) {
  const identity = useId();
  const model = useMemo(() => describeUnifiedDiff(diff), [diff]);
  return <WorkbenchDiffLines model={model} identity={identity} surface={surface === "framed" ? "framed" : "thread"} />;
}

function ThreadPlainOutput ({
  output,
  surface = "default",
}: {
  output: string;
  surface?: ThreadCodeDisplaySurface;
}) {
  const isFramed = surface === "framed";
  const compactedOutput = compactCommandOutput(output) ?? "";

  return (
    <pre
      className={`
        m-0 overflow-x-auto whitespace-pre ${isFramed ? "bg-transparent" : ""}
        px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text md:px-12
      `}
      style={isFramed ? undefined : CODE_SURFACE_EDGE_STYLE}
    >
      <ThreadAnsiOutput output={compactedOutput} />
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
      <ThreadPreviewFrame contentPadding="none" height={props.previewHeight ?? "24rem"} mode={props.previewHeight === "auto" ? "panel" : "scroll"}>
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
