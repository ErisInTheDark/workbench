/*
 * Exports:
 * - default WorkbenchPinnedThreadSidebar: render the filtered global pinned disclosure above project navigation.
 */
"use client";

import type { WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchSelectedProjectPinPlacement } from "../../workbench/state/workbench-settings";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import type { WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchPinnedThreadList from "./WorkbenchPinnedThreadList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

export default function WorkbenchPinnedThreadSidebar({
  activeDragPayload,
  currentTarget,
  onOpenThread,
  projectId,
  projects,
  selectedProjectPinPlacement,
  selectedOwnerProjectId,
  logicalProjects,
  logicalThreads,
  logicalSummaries,
  presentation,
  controls,
  attachedDaemonId,
  selectedLogicalProjectId,
  selectedLocation,
  onOpenQualifiedThread,
}: {
  activeDragPayload: WorkbenchDragPayload | null;
  currentTarget: WorkbenchThreadTarget | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  projects: readonly WorkbenchProjectOption[];
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
  selectedOwnerProjectId: string;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  logicalSummaries?: Readonly<Record<string, WorkbenchLogicalProjectSummary>>;
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  attachedDaemonId?: string | null;
  selectedLogicalProjectId?: string | null;
  selectedLocation?: { daemonId: string; projectId: string } | null;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
}) {
  const actions = WorkbenchThreadSidebarActionsProvider.useActions();
  return (
    <nav aria-label="Pinned threads">
      <WorkbenchPinnedThreadList
        activeDragPayload={activeDragPayload}
        actions={actions}
        currentTarget={currentTarget}
        onOpenThread={onOpenThread}
        projectId={projectId}
        projects={projects}
        selectedProjectPinPlacement={selectedProjectPinPlacement}
        selectedOwnerProjectId={selectedOwnerProjectId}
        logicalProjects={logicalProjects}
        logicalThreads={logicalThreads}
        logicalSummaries={logicalSummaries}
        presentation={presentation}
        controls={controls}
        attachedDaemonId={attachedDaemonId}
        selectedLogicalProjectId={selectedLogicalProjectId}
        selectedLocation={selectedLocation}
        onOpenQualifiedThread={onOpenQualifiedThread}
      />
    </nav>
  );
}
