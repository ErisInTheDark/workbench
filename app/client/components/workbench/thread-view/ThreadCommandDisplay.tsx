/*
 * Exports:
 * - default ThreadCommandDisplay: one command as a step row (kind icon, one-line summary, trailing meta) opening onto its detail, shared by execution and approval.
 */
"use client";
import { createElement, type ReactNode } from "react";
import type { ThreadCommandDisplay as CommandDisplay, ThreadCommandDetailRow, ThreadCommandSummaryDisplay } from "../../../workbench/thread/thread-command-matchers";
import ThreadCommandDetailRows from "./ThreadCommandDetailRows";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadCommandDetails from "./ThreadCommandDetails";
import ThreadStepRow from "./ThreadStepRow";
import { getCommandIcon } from "./thread-activity-chips";
import { ThreadCommandSummary } from "./thread-view-primitives";
import type { ThreadItemApprovalState } from "../../../workbench/thread/thread-item-approvals";

export default function ThreadCommandDisplay({ approval = null, command, display, summaryDisplay = display, detailRows = display.detailRows ?? [], meta, children, projectFilePaths, projectId, browse = false, output, previewHeight }: {
  approval?: ThreadItemApprovalState | null;
  command: string;
  display: CommandDisplay;
  summaryDisplay?: ThreadCommandSummaryDisplay;
  detailRows?: ThreadCommandDetailRow[];
  /** Trailing details such as exit code and duration. */
  meta?: readonly ReactNode[];
  children?: ReactNode;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  browse?: boolean;
  output?: string | null;
  previewHeight?: string;
}) {
  return (
    <ThreadStepRow
      icon={createElement(getCommandIcon(summaryDisplay.summaryStats), { size: 16 })}
      meta={meta}
      summary={<ThreadCommandSummary approval={approval} display={summaryDisplay} line projectFilePaths={projectFilePaths} projectId={projectId} />}
    >
      {display.cwdDisplay && !display.hideCommandCwd ? (
        <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted">
          Working dir: <span className="break-all font-mono text-text">{display.cwdDisplay}</span>
        </p>
      ) : null}
      {detailRows.length ? <ThreadCommandDetailRows rows={detailRows} projectFilePaths={projectFilePaths} projectId={projectId} /> : null}
      {children !== undefined ? children : browse ? <ThreadCommandDetails command={command} output={output} previewHeight={previewHeight} />
        : display.hideCommandOutput && (detailRows.length > 0 || !output?.trim()) ? null
          : <ThreadCodeDisplay header={<ThreadCommandHeader command={command} surface="framed" />} output={output?.trim() || undefined} preview previewHeight={previewHeight} variant="plain" />}
    </ThreadStepRow>
  );
}
