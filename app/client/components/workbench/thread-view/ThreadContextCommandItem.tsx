/*
 * Exports:
 * - default ThreadContextCommandItem: a Thread Recall command or context alias as one step line (its recall glyph, summary,
 *   exit and duration) that opens into the recalled records. Keywords: thread recall, context, records, step.
 * - ThreadContextCommandSource: transport-neutral Thread Recall lifecycle and output data. Keywords: thread recall, CLI, MCP, source.
 */
"use client";

import type { ReactNode } from "react";

import ContextualProjectProvider from "../ContextualProjectProvider";
import { useProject } from "../use-projects";
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
import ThreadStepRow from "./ThreadStepRow";
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
  activeStartedAtMs,
  defaultOpen = false,
  operation,
  source,
  renderRecord,
}: {
  activeStartedAtMs?: number | null;
  defaultOpen?: boolean;
  operation: WorkbenchThreadRecallOperation;
  source: ThreadContextCommandSource;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
}) {
  const project = useProject.contextual();
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
    <ThreadStepRow
      defaultOpen={defaultOpen}
      icon={<ThreadRecallIcon empty={emptyResult} operation={operation} />}
      iconLabel={iconLabel}
      meta={[
        source.outcome === "failed" && source.exitCode !== null && source.exitCode !== 0
          ? <ThreadSummaryText key="exit" text={`exit ${source.exitCode}`} /> : null,
      ]}
      progress={{ durationMs: source.durationMs, startedAtMs: activeStartedAtMs, state: source.outcome }}
      summary={<ThreadCommandSummary display={summaryDisplay} />}
    >
      <ThreadPreviewFrame
        backgroundClassName="before:bg-[linear-gradient(to_right,transparent,#8882_10%,#8882_90%,transparent)]"
        contentClassName="mb-8 px-4 py-8"
        edgeBleed="wide"
        edgeOffset="none"
        mode="panel"
      >
        {markdown ? (
          <ContextualProjectProvider cwd={project?.cwd ?? source.cwd}>
            <ThreadRecallOutput markdown={markdown} renderRecord={renderRecord} />
          </ContextualProjectProvider>
        ) : (
          <p className="m-0 text-[0.92em] leading-[1.6] text-fg/muted">No Thread Recall output captured.</p>
        )}
      </ThreadPreviewFrame>
    </ThreadStepRow>
  );
}
