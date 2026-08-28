/*
 * Exports:
 * - default WorkbenchThreadStatusCountsButton: render the canonical full-counts to grey-Working-icon toggle used by sidebar disclosure summaries. Keywords: thread, status, counts, button, collapse, sidebar.
 */
"use client";

import { useState } from "react";

import type { WorkbenchProjectThreadSummaryCounts } from "../../lib/workbench/thread/thread-state";
import { WorkingThreadIcon } from "./workbench-icons";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";

export default function WorkbenchThreadStatusCountsButton({
  counts,
  label,
}: {
  counts: WorkbenchProjectThreadSummaryCounts;
  label: string;
}) {
  const [showStatuses, setShowStatuses] = useState(true);
  if (!WorkbenchThreadStatusCounts.hasCounts(counts)) return null;

  const actionLabel = showStatuses ? `Collapse ${label} status counts` : `Expand ${label} status counts`;
  return (
    <button
      aria-label={actionLabel}
      aria-pressed={showStatuses}
      className="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1.5 py-1 text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
      data-thread-summary-action="true"
      onClick={() => setShowStatuses((current) => !current)}
      title={actionLabel}
      type="button"
    >
      {showStatuses
        ? <WorkbenchThreadStatusCounts counts={counts} />
        : <WorkingThreadIcon className="size-3.5 text-muted" />}
    </button>
  );
}
