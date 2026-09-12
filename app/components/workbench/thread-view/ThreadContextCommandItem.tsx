/*
 * Exports:
 * - default ThreadContextCommandItem: render a Thread Recall command or context alias as a semantic tagged-record disclosure. Keywords: thread recall, context, records, disclosure.
 * - ThreadContextCommandSource: transport-neutral Thread Recall lifecycle and output data. Keywords: thread recall, CLI, MCP, source.
 * - Local helpers: select recall result icons and format execution metadata for the disclosure summary. Keywords: status, duration, exit code.
 */
"use client";

import type { ReactNode } from "react";

import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  summarizeWorkbenchThreadRecallOutput,
  type WorkbenchThreadRecallOutputRecord,
} from "../../../workbench/thread/thread-recall-output";
import {
  getThreadCommandOutcomeDisplay,
  getWorkbenchThreadRecallSummaryDisplay,
  type ThreadCommandExecutionOutcome,
  type WorkbenchThreadRecallOperation,
} from "../../../workbench/thread/thread-command-matchers";
import {
  BookBookmarkDashedIcon,
  BookBookmarkIcon,
  BookDashedIcon,
  BookIcon,
  BookSearchDashedIcon,
  BookSearchIcon,
} from "../workbench-icons";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadRecallOutput from "./ThreadRecallOutput";
import ThreadSummaryText from "./ThreadSummaryText";
import { ThreadCommandSummary } from "./thread-view-primitives";

export interface ThreadContextCommandSource {
  cwd: string;
  durationMs: number | null;
  exitCode: number | null;
  id: string;
  outcome: ThreadCommandExecutionOutcome;
  output: string;
}

function ThreadContextCommandMetaParts({
  source,
}: {
  source: ThreadContextCommandSource;
}) {
  const metaParts: ReactNode[] = [];

  if (source.outcome === "failed" && source.exitCode !== null && source.exitCode !== 0) {
    metaParts.push(
      <ThreadSummaryText
        key={`${source.id}:exit`}
        text={`exit ${source.exitCode}`}
      />,
    );
  }

  if (source.durationMs !== null) {
    metaParts.push(
      <ThreadDurationText
        key={`${source.id}:duration`}
        durationMs={source.durationMs}
      />,
    );
  }

  if (!metaParts.length) {
    return null;
  }

  return (
    <span className="ml-2 text-[0.78em] text-fg/muted">
      {metaParts.map((part, index) => (
        <span key={`${source.id}:meta:${index}`}>
          {index ? <span className="text-fg/muted"> | </span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function ThreadRecallIcon({
  empty,
  operation,
}: {
  empty: boolean;
  operation: WorkbenchThreadRecallOperation;
}) {
  const Icon = operation.action === "search"
    ? empty ? BookSearchDashedIcon : BookSearchIcon
    : operation.action === "expand"
      ? empty ? BookBookmarkDashedIcon : BookBookmarkIcon
      : empty ? BookDashedIcon : BookIcon;
  return <Icon size={16} />;
}

export default function ThreadContextCommandItem ({
  defaultOpen = false,
  operation,
  source,
  projectFilePaths,
  projectId,
  projectRootPath,
  renderRecord,
  threadCwdPath,
  workspaceRoots,
}: {
  defaultOpen?: boolean;
  operation: WorkbenchThreadRecallOperation;
  source: ThreadContextCommandSource;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
  threadCwdPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const markdown = source.output.trim();
  const outputSummary = summarizeWorkbenchThreadRecallOutput(markdown);
  const summaryDisplay = getThreadCommandOutcomeDisplay(
    getWorkbenchThreadRecallSummaryDisplay(operation, outputSummary),
    source.outcome,
  );
  const emptyResult = source.outcome === "completed" && outputSummary?.recordCount === 0;
  const iconLabel = operation.action === "search"
    ? "Thread Recall search"
    : operation.action === "expand"
      ? "Thread Recall from position"
      : "Thread Recall";

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2"
      defaultOpen={defaultOpen}
      leading={<ThreadRecallIcon empty={emptyResult} operation={operation} />}
      leadingLabel={iconLabel}
      summary={(
        <>
          <ThreadCommandSummary
            display={summaryDisplay}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
          />
          <ThreadContextCommandMetaParts source={source} />
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadPreviewFrame
        backgroundClassName="before:bg-[linear-gradient(to_right,transparent,#8882_10%,#8882_90%,transparent)]"
        contentClassName="mb-8 px-4 py-8"
        edgeBleed="wide"
        edgeOffset="none"
        mode="panel"
      >
        {markdown ? (
          <ThreadRecallOutput
            markdown={markdown}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            renderRecord={renderRecord}
            threadCwdPath={threadCwdPath ?? source.cwd}
            workspaceRoots={workspaceRoots}
          />
        ) : (
          <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No Thread Recall output captured.</p>
        )}
      </ThreadPreviewFrame>
    </ThreadDisclosure>
  );
}
