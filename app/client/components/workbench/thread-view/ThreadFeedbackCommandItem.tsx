/*
 * Exports:
 * - default ThreadFeedbackCommandItem: render a titled feedback invocation with the shared stats report display.
 */
"use client";

import type { WorkbenchFeedbackOperation } from "../../../workbench/thread/thread-command-matchers";
import { WorkbenchFeedbackReportDisplay } from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackTag from "../stats/workspaces/WorkbenchStatsFeedbackTag";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";

export default function ThreadFeedbackCommandItem({
  durationMs,
  operation,
  outcome,
  projectId,
}: {
  durationMs: number | null;
  operation: WorkbenchFeedbackOperation;
  outcome: "completed" | "inProgress";
  projectId?: string | null;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      renderContent={() => (
        <WorkbenchFeedbackReportDisplay
          category={operation.category}
          clamp={false}
          projectId={projectId}
          report={operation.report}
          title={operation.title}
        />
      )}
      summary={(
        <>
          <span>{outcome === "inProgress" ? "Reporting" : "Reported"}</span>
          <WorkbenchStatsFeedbackTag category={operation.category} size="compact" />
          <span className="min-w-0 truncate font-semibold text-text">{operation.title}</span>
          {durationMs === null ? null : (
            <ThreadDurationText className="ml-1 text-[0.78em] text-fg/muted" durationMs={durationMs} />
          )}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    />
  );
}
