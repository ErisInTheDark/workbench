/*
 * Exports:
 * - default ThreadGitArcConflictList: render reusable compact navigable thread rows for Git arc ownership conflicts. Keywords: thread, git, arc, conflict, navigation, list.
 */
"use client";

import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "../../../lib/workbench/thread/thread-state";
import { createThreadHref } from "../../../lib/workbench/navigation/workbench-route";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";

type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export default function ThreadGitArcConflictList({
  entries,
  onOpenThread,
  projectId,
}: {
  entries: readonly ProviderThreadSidebarEntry[];
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: string;
}) {
  if (!entries.length) return null;
  return (
    <ul className="m-0 flex flex-col gap-1 py-1" data-thread-git-arc-conflict-list="true">
      {entries.map((entry) => (
        <WorkbenchThreadListItem
          className="pb-px"
          compact
          entry={entry}
          href={createThreadHref(projectId, { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId })}
          key={`${entry.identity.harness}:${entry.identity.threadId}`}
          onActivate={onOpenThread}
          projectId={projectId}
          showTooltip={false}
        />
      ))}
    </ul>
  );
}
