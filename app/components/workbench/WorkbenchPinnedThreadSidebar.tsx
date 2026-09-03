/*
 * Exports:
 * - default WorkbenchPinnedThreadSidebar: render the filtered global pinned disclosure above project navigation. Keywords: pinned, sidebar, projects, placement, route.
 */
"use client";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkbenchSelectedProjectPinPlacement } from "../../workbench/state/workbench-settings";
import type { WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchPinnedThreadList from "./WorkbenchPinnedThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

export default function WorkbenchPinnedThreadSidebar({
  currentTarget,
  onOpenThread,
  projectId,
  projects,
  selectedProjectPinPlacement,
  selectedOwnerProjectId,
}: {
  currentTarget: WorkbenchThreadTarget | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  projects: readonly WorkbenchProjectOption[];
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
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
        selectedProjectPinPlacement={selectedProjectPinPlacement}
        selectedOwnerProjectId={selectedOwnerProjectId}
      />
    </nav>
  );
}
