/*
 * Exports:
 * - default WorkbenchThreadStatusCountsButton: render the canonical full-counts to grey-Working-icon toggle used by sidebar disclosure summaries.
 */
"use client";

import type { WorkbenchProjectThreadSummaryCounts } from "workbench-shared/workbench/thread/thread-state";
import { WorkingThreadIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";

export default function WorkbenchThreadStatusCountsButton({
  counts,
  label,
  scope,
}: {
  counts: WorkbenchProjectThreadSummaryCounts;
  label: string;
  scope: "pinned" | "project";
}) {
  const { preferences, setStatusCountsExpanded } = useWorkbenchSidebarPreferences();
  const showStatuses = scope === "pinned"
    ? preferences.pinnedStatusCountsExpanded
    : preferences.projectStatusCountsExpanded;
  if (!WorkbenchThreadStatusCounts.hasCounts(counts)) return null;

  const actionLabel = showStatuses ? `Collapse ${label} status counts` : `Expand ${label} status counts`;
  return (
    <button
      aria-label={actionLabel}
      aria-pressed={showStatuses}
      className="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1.5 py-1 text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
      data-thread-summary-action="true"
      onClick={() => setStatusCountsExpanded(scope, !showStatuses)}
      title={actionLabel}
      type="button"
    >
      {showStatuses
        ? <WorkbenchThreadStatusCounts counts={counts} />
        : <WorkingThreadIcon className="text-muted" size={14} />}
    </button>
  );
}
