/*
 * Exports:
 * - default ThreadRecallOutput: lazily render measured Recall records and preserve Markdown fallback.
 */
"use client";

import { type ReactNode } from "react";
import type { WorkbenchThreadRecallKind } from "workbench-shared/types";
import {
  parseWorkbenchThreadRecallOutput,
  type WorkbenchThreadRecallOutputRecord,
} from "../../../workbench/thread/thread-recall-output";
import Disclosure from "../../ui/Disclosure";
import MarkdownRender from "../../ui/MarkdownRender";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadMeasuredContent from "./ThreadMeasuredContent";

function RecallRecord({ record, index, renderRecord }: {
  record: WorkbenchThreadRecallOutputRecord;
  index: number;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
}) {
  return renderRecord(record, index);
}

const COLLAPSED_RECORD_LABELS: Partial<Record<WorkbenchThreadRecallKind, string>> = {
  questionnaire: "Questionnaire response",
  "proof-of-work": "Proof of work",
};

function ThreadRecallCollapsedRecord({ label, record }: { label: string; record: WorkbenchThreadRecallOutputRecord }) {
  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text={label} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <MarkdownRender markdown={record.text} />
    </Disclosure>
  );
}

export default function ThreadRecallOutput({
  markdown,
  renderRecord,
}: {
  markdown: string;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
}) {
  const segments = parseWorkbenchThreadRecallOutput(markdown);
  return (
    <div className="space-y-2">
      {segments.map((segment, index) => {
        if (segment.type === "markdown") {
          return (
            <ThreadMeasuredContent key={`markdown:${index}`}>
              <MarkdownRender markdown={segment.markdown} />
            </ThreadMeasuredContent>
          );
        }
        const collapsedLabel = COLLAPSED_RECORD_LABELS[segment.record.kind];
        if (collapsedLabel) {
          return <ThreadRecallCollapsedRecord key={`record:${segment.record.ref}:${index}`} label={collapsedLabel} record={segment.record} />;
        }
        return (
          <ThreadMeasuredContent key={`record:${segment.record.ref}:${index}`}>
            <RecallRecord record={segment.record} index={index} renderRecord={renderRecord} />
          </ThreadMeasuredContent>
        );
      })}
    </div>
  );
}
