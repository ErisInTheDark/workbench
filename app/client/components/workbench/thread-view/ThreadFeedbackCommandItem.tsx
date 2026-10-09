/*
 * Exports:
 * - default ThreadFeedbackCommandItem: render a wb feedback call as its category and title, expanding into the stored report as the stats view shows it.
 */
"use client";

import type { WorkbenchFeedbackOperation } from "../../../workbench/thread/thread-command-matchers";
import useStats from "../stats/use-stats";
import {
  WorkbenchFeedbackReportBody,
  WorkbenchFeedbackReportDisplay,
  WorkbenchFeedbackReportSkeleton,
} from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackTag from "../stats/workspaces/WorkbenchStatsFeedbackTag";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";

/** Mounts only once the disclosure opens, so the stored report is read on demand. */
function FeedbackReportContent({ feedbackId, operation, outcome, projectId, threadId }: {
  feedbackId: number | null;
  operation: WorkbenchFeedbackOperation;
  outcome: "completed" | "inProgress";
  projectId?: string | null;
  threadId: string;
}) {
  const report = useStats.feedbackReport(feedbackId === null ? null : { feedbackId, threadId });
  const item = report?.status === "ready" ? report.item : null;
  const modelName = useStats.modelNames(item?.harness ? [item.harness] : []);
  if (item) {
    return <WorkbenchFeedbackReportBody clamp={false} item={item} modelName={modelName(item.harness, item.model)} showThread={false} />;
  }
  // A call still running has no stored report yet; one that finished without an id, or whose report is gone, shows what it filed.
  if (outcome === "inProgress" || report?.status === "loading") return <WorkbenchFeedbackReportSkeleton />;
  const note = report?.status === "deleted" ? "This report has since been deleted."
    : report?.status === "failed" ? `The stored report is unavailable: ${report.failure}` : null;
  return (
    <>
      <WorkbenchFeedbackReportDisplay
        category={operation.category}
        clamp={false}
        projectId={projectId}
        report={operation.report}
        title={operation.title}
      />
      {note ? <p className="m-0 mt-1 text-[0.72rem] text-fg/muted">{note}</p> : null}
    </>
  );
}

export default function ThreadFeedbackCommandItem({
  durationMs,
  feedbackId,
  operation,
  outcome,
  projectId,
  threadId,
}: {
  durationMs: number | null;
  /** The stored report's id from the call's acknowledgement; null until the call completes. */
  feedbackId: number | null;
  operation: WorkbenchFeedbackOperation;
  outcome: "completed" | "inProgress";
  projectId?: string | null;
  threadId: string;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      renderContent={() => (
        <FeedbackReportContent
          feedbackId={feedbackId}
          operation={operation}
          outcome={outcome}
          projectId={projectId}
          threadId={threadId}
        />
      )}
      summary={(
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{outcome === "inProgress" ? "Reporting" : "Reported"}</span>
          <WorkbenchStatsFeedbackTag category={operation.category} size="compact" />
          <span className="min-w-0 truncate font-semibold text-text">{operation.title}</span>
          {durationMs === null ? null : (
            <ThreadDurationText className="shrink-0 text-[0.78em] text-fg/muted" durationMs={durationMs} />
          )}
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    />
  );
}
