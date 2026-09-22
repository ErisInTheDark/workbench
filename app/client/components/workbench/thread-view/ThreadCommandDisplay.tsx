/*
 * Exports:
 * - default ThreadCommandDisplay: the configured command disclosure shared by execution and approval.
 */
"use client";
import type { ReactNode } from "react";
import type { ThreadCommandDisplay as CommandDisplay, ThreadCommandDetailRow, ThreadCommandSummaryDisplay } from "../../../workbench/thread/thread-command-matchers";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadCommandDetailRows from "./ThreadCommandDetailRows";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadCommandDetails from "./ThreadCommandDetails";
import { ThreadCommandSummary } from "./thread-view-primitives";

export default function ThreadCommandDisplay({ command, display, summaryDisplay = display, detailRows = display.detailRows ?? [], meta, children, projectFilePaths, projectId, browse = false, output, previewHeight }: {
  command: string;
  display: CommandDisplay;
  summaryDisplay?: ThreadCommandSummaryDisplay;
  detailRows?: ThreadCommandDetailRow[];
  meta?: ReactNode;
  children?: ReactNode;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  browse?: boolean;
  output?: string | null;
  previewHeight?: string;
}) {
  return (
    <ThreadDisclosure className="py-2" contentClassName="mt-2 space-y-2 pl-6"
      summary={<><ThreadCommandSummary display={summaryDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />{meta}</>}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted">
      {display.cwdDisplay && !display.hideCommandCwd ? (
        <p className="m-0 text-[0.78em] leading-[1.6] text-fg/muted">
          Working dir: <span className="break-all font-mono text-text">{display.cwdDisplay}</span>
        </p>
      ) : null}
      {detailRows.length ? <ThreadCommandDetailRows rows={detailRows} projectFilePaths={projectFilePaths} projectId={projectId} /> : null}
      {children !== undefined ? children : browse ? <ThreadCommandDetails command={command} output={output} previewHeight={previewHeight} />
        : display.hideCommandOutput && (detailRows.length > 0 || !output?.trim()) ? null
          : <ThreadCodeDisplay header={<ThreadCommandHeader command={command} surface="framed" />} output={output?.trim() || undefined} preview previewHeight={previewHeight} variant="plain" />}
    </ThreadDisclosure>
  );
}
