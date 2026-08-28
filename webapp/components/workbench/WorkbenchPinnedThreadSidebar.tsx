/*
 * Exports:
 * - default WorkbenchPinnedThreadSidebar: render the global pinned-thread disclosure above project navigation while preserving viewed-project routes. Keywords: pinned, sidebar, projects, route.
 */
"use client";

import type { WorkbenchProjectOption } from "../../lib/types";
import type { WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import WorkbenchPinnedThreadList from "./WorkbenchPinnedThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

export default function WorkbenchPinnedThreadSidebar({
  currentTarget,
  onOpenThread,
  projectId,
  projects,
  selectedOwnerProjectId,
}: {
  currentTarget: WorkbenchThreadTarget | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  projects: readonly WorkbenchProjectOption[];
  selectedOwnerProjectId: string;
}) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  return (
    <nav aria-label="Pinned threads">
      <WorkbenchPinnedThreadList
        actions={actions}
        currentTarget={currentTarget}
        onOpenThread={onOpenThread}
        projectId={projectId}
        projects={projects}
        selectedOwnerProjectId={selectedOwnerProjectId}
      />
    </nav>
  );
}
