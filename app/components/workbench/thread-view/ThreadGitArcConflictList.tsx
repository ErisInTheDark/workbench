/*
 * Exports:
 * - default ThreadGitArcConflictList: render compact conflict threads with optional intersecting file links. Keywords: thread, git, arc, conflict, navigation, list, files.
 */
"use client";

import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import { createThreadHref } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import ProjectFileLinkList from "../ProjectFileLinkList";

type ProviderThreadSidebarEntry = Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;

export default function ThreadGitArcConflictList({
  entries,
  onOpenThread,
  projectId,
}: {
  entries: readonly { entry: ProviderThreadSidebarEntry; paths: readonly string[] }[];
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: string;
}) {
  if (!entries.length) return null;
  const projectFilePaths = entries.flatMap(({ paths }) => paths);
  return (
    <ul className="m-0 flex flex-col gap-1 px-1 py-1" data-thread-git-arc-conflict-list="true">
      {entries.map(({ entry, paths }) => (
        <WorkbenchThreadListItem
          className="pb-px"
          compact
          entry={entry}
          href={createThreadHref(projectId, { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId })}
          key={`${entry.identity.harness}:${entry.identity.threadId}`}
          onActivate={onOpenThread}
          projectId={projectId}
          secondaryRow={paths.length ? <ProjectFileLinkList paths={paths} projectFilePaths={projectFilePaths} projectId={projectId} /> : undefined}
          showTooltip={false}
        />
      ))}
    </ul>
  );
}
