/*
 * Exports:
 * - default WorkbenchThreadStatusCounts: render compact shared lifecycle counts and own canonical status metadata plus count helpers.
 */

import type { ComponentType } from "react";

import type {
  WorkbenchPinnedThreadSummaryEntry,
  WorkbenchProjectThreadSummaryCounts,
  WorkbenchProjectThreadSummaryEntry,
} from "workbench-shared/workbench/thread/thread-state";
import { getWorkbenchThreadStatusClassName, type WorkbenchThreadStatusTone } from "./workbench-thread-status-colors";
import {
  CompletedThreadIcon,
  NeedsAttentionThreadIcon,
  ProposedCommitThreadIcon,
  StoppedThreadIcon,
  WorkingThreadIcon,
  type IconProps,
} from "./workbench-icons";

type StatusIcon = ComponentType<IconProps>;
interface WorkbenchThreadStatusItem {
  dashed: boolean;
  Icon: StatusIcon;
  key: WorkbenchProjectThreadSummaryEntry["status"];
  label: string;
  tone: WorkbenchThreadStatusTone;
}

const EMPTY_WORKBENCH_THREAD_STATUS_COUNTS: WorkbenchProjectThreadSummaryCounts = {
  completed: 0,
  needsAttention: 0,
  needsAttentionActive: 0,
  proposedCommit: 0,
  stopped: 0,
  waiting: 0,
  working: 0,
};

const WORKBENCH_THREAD_STATUS_ITEMS: WorkbenchThreadStatusItem[] = [
  { dashed: true, Icon: NeedsAttentionThreadIcon, key: "needsAttentionActive", label: "Needs attention", tone: "needs-attention-active" },
  { dashed: true, Icon: NeedsAttentionThreadIcon, key: "needsAttention", label: "Snoozed needs attention", tone: "needs-attention" },
  { dashed: false, Icon: WorkingThreadIcon, key: "working", label: "Working", tone: "working" },
  { dashed: false, Icon: WorkingThreadIcon, key: "waiting", label: "Waiting", tone: "waiting" },
  { dashed: true, Icon: StoppedThreadIcon, key: "stopped", label: "Stopped", tone: "stopped" },
  { dashed: false, Icon: ProposedCommitThreadIcon, key: "proposedCommit", label: "Proposed commit", tone: "completed" },
  { dashed: false, Icon: CompletedThreadIcon, key: "completed", label: "Completed", tone: "completed" },
];

const WORKBENCH_THREAD_STATUS_ITEMS_BY_KEY = new Map(
  WORKBENCH_THREAD_STATUS_ITEMS.map((item) => [item.key, item]),
);

function addWorkbenchThreadStatusCounts(
  left: WorkbenchProjectThreadSummaryCounts,
  right: WorkbenchProjectThreadSummaryCounts,
): WorkbenchProjectThreadSummaryCounts {
  return {
    completed: left.completed + right.completed,
    needsAttention: left.needsAttention + right.needsAttention,
    needsAttentionActive: left.needsAttentionActive + right.needsAttentionActive,
    proposedCommit: left.proposedCommit + right.proposedCommit,
    stopped: left.stopped + right.stopped,
    waiting: (left.waiting ?? 0) + (right.waiting ?? 0),
    working: left.working + right.working,
  };
}

function hasWorkbenchThreadStatusCounts(counts: WorkbenchProjectThreadSummaryCounts) {
  return WORKBENCH_THREAD_STATUS_ITEMS.some(({ key }) => (counts[key] ?? 0) > 0);
}

function countPinnedThreadStatuses(entries: readonly WorkbenchPinnedThreadSummaryEntry[]) {
  return entries.reduce<WorkbenchProjectThreadSummaryCounts>((counts, entry) => {
    if (entry.status !== "draft") counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }, { ...EMPTY_WORKBENCH_THREAD_STATUS_COUNTS });
}

function subtractWorkbenchThreadStatusCounts(
  counts: WorkbenchProjectThreadSummaryCounts,
  excluded: WorkbenchProjectThreadSummaryCounts,
): WorkbenchProjectThreadSummaryCounts {
  return {
    completed: Math.max(0, counts.completed - excluded.completed),
    needsAttention: Math.max(0, counts.needsAttention - excluded.needsAttention),
    needsAttentionActive: Math.max(0, counts.needsAttentionActive - excluded.needsAttentionActive),
    proposedCommit: Math.max(0, counts.proposedCommit - excluded.proposedCommit),
    stopped: Math.max(0, counts.stopped - excluded.stopped),
    waiting: Math.max(0, (counts.waiting ?? 0) - (excluded.waiting ?? 0)),
    working: Math.max(0, counts.working - excluded.working),
  };
}

const WorkbenchThreadStatusCounts = Object.assign(function WorkbenchThreadStatusCounts({
  counts,
  excludeKey,
}: {
  counts: WorkbenchProjectThreadSummaryCounts;
  excludeKey?: WorkbenchThreadStatusItem["key"];
}) {
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5">
      {WORKBENCH_THREAD_STATUS_ITEMS.flatMap(({ Icon, key, label, tone }) => key !== excludeKey && counts[key] ? [(
        <span
          aria-label={`${label}: ${counts[key]}`}
          className={`inline-flex min-w-0 items-center gap-0.5 text-[0.72rem] font-semibold ${getWorkbenchThreadStatusClassName(tone)}`}
          key={key}
          title={`${label}: ${counts[key]}`}
        >
          <Icon className="shrink-0" size={14} />
          <span>{counts[key]}</span>
        </span>
      )] : [])}
    </span>
  );
}, {
  addCounts: addWorkbenchThreadStatusCounts,
  countPinnedStatuses: countPinnedThreadStatuses,
  emptyCounts: EMPTY_WORKBENCH_THREAD_STATUS_COUNTS,
  hasCounts: hasWorkbenchThreadStatusCounts,
  items: WORKBENCH_THREAD_STATUS_ITEMS,
  itemsByKey: WORKBENCH_THREAD_STATUS_ITEMS_BY_KEY,
  subtractCounts: subtractWorkbenchThreadStatusCounts,
});

export default WorkbenchThreadStatusCounts;
