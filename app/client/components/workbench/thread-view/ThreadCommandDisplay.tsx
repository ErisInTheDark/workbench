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

export default function ThreadCommandDisplay({ approval = null, command, display, expensive = false, summaryDisplay = display, detailRows = display.detailRows ?? [], meta, children, browse = false, live = false, output, previewHeight }: {
  approval?: ThreadItemApprovalState | null;
  /** The command is actually running (not queued), so its line shimmers. */
  live?: boolean;
  command: string;
  /** A wb shell command marked expensive, queueing for a machine-wide slot. */
  expensive?: boolean;
  display: CommandDisplay;
  summaryDisplay?: ThreadCommandSummaryDisplay;
  detailRows?: ThreadCommandDetailRow[];
  /** Trailing details such as exit code and duration. */
  meta?: readonly ReactNode[];
  children?: ReactNode;
  browse?: boolean;
  output?: string | null;
  previewHeight?: string;
}) {
  return (
    <ThreadStepRow
      icon={createElement(getCommandIcon(summaryDisplay.summaryStats), { size: 16 })}
      live={live}
      meta={meta}
      summary={<ThreadCommandSummary approval={approval} display={summaryDisplay} expensive={expensive} line />}
    >
      {display.cwdDisplay && !display.hideCommandCwd ? (
        <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted">
          Working dir: <span className="break-all font-mono text-text">{display.cwdDisplay}</span>
        </p>
      ) : null}
      {detailRows.length ? <ThreadCommandDetailRows rows={detailRows} /> : null}
      {children !== undefined ? children : browse ? <ThreadCommandDetails command={command} output={output} previewHeight={previewHeight} />
        : display.hideCommandOutput && (detailRows.length > 0 || !output?.trim()) ? null
          : <ThreadCodeDisplay header={<ThreadCommandHeader command={command} surface="framed" />} output={output?.trim() || undefined} preview previewHeight={previewHeight} variant="plain" />}
    </ThreadStepRow>
  );
}
