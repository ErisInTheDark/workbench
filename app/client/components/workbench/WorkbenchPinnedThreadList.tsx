/*
 * Exports:
 * - default WorkbenchPinnedThreadList: render filtered Workbench-wide pins, mixed-project folders, rows, actions, and drag order.
 */
"use client";

import { useMemo } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { createPinnedThreadRoute, createThreadRoute, isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import {
  findThreadDisplayFolder,
  getProjectQualifiedThreadDisplayKey,
  getThreadDisplayDraftKey,
  getThreadDisplayFolderKey,
  getThreadDisplayThreadKey,
  projectThreadDisplayLayoutSection,
  type ThreadDisplayLayoutItem,
} from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchThreadTarget as CanonicalThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import {
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadRouteTarget as WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
} from "../../workbench/layout/workbench-drag";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchSelectedProjectPinPlacement } from "../../workbench/state/workbench-settings";
import {
  mergeContextMenuPlacementEntries,
  useContextMenuPlacementSnapshot,
} from "./context-menu-placement";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";
import { PinIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadPriorityDropZone from "./WorkbenchThreadPriorityDropZone";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";

const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type PinnedThreadListActions = Pick<ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>,
  | "autoFocusFolderId"
  | "getThreadContextMenu"
  | "nowMs"
  | "onAction"
  | "onAutoFocusFolderComplete"
  | "onPinnedFolderDrop"
  | "onPinnedMove"
  | "onRenamePinnedFolder"
  | "onSetPriority"
  | "onSnoozeUntil"
  | "pinnedDisplayOrder"
  | "projectThreadSidebars"
  | "projectThreadSummaries"
>;
type GlobalPinnedListEntry = WorkbenchPinnedThreadSummaryEntry | Exclude<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>;
type GlobalPinnedEntry = { entry: GlobalPinnedListEntry; project: WorkbenchProjectOption };

function targetForEntry (entry: GlobalPinnedListEntry): CanonicalThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: "draftId" in entry ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function displayKeyForEntry (entry: GlobalPinnedListEntry) {
  return entry.entryKind === "draft"
    ? getThreadDisplayDraftKey("draftId" in entry ? entry.draftId : entry.draft.draftId)
    : getThreadDisplayThreadKey(entry.identity.harness, entry.identity.threadId);
}

function displayKeyForGlobalEntry ({ entry, project }: GlobalPinnedEntry) {
  return getProjectQualifiedThreadDisplayKey(project.id, displayKeyForEntry(entry));
}

function mergePinnedDisplayItems (
  items: Array<ThreadDisplayLayoutItem<GlobalPinnedEntry>>,
  currentEntries: readonly GlobalPinnedEntry[],
) {
  const placementEntries = items.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]);
  const mergedByKey = new Map(mergeContextMenuPlacementEntries(
    placementEntries,
    currentEntries,
    displayKeyForGlobalEntry,
  ).map(entry => [displayKeyForGlobalEntry(entry), entry]));
  const current = (entry: GlobalPinnedEntry) => mergedByKey.get(displayKeyForGlobalEntry(entry)) ?? entry;
  return items.map(item => item.itemKind === "folder"
    ? { ...item, entries: item.entries.map(current) }
    : { ...item, entry: current(item.entry) });
}

export default function WorkbenchPinnedThreadList ({
  activeDragPayload,
  actions,
  currentTarget,
  onOpenThread,
  projectId,
  projects,
  selectedProjectPinPlacement,
  selectedOwnerProjectId,
}: {
  activeDragPayload: WorkbenchDragPayload | null;
  actions: PinnedThreadListActions;
  currentTarget: WorkbenchThreadTarget | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  projects: readonly WorkbenchProjectOption[];
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
  selectedOwnerProjectId: string;
}) {
  const isShiftPressed = useNonTextInputShiftKey();
  const { preferences, setFolderOpen } = useWorkbenchSidebarPreferences();
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const projectHref = useWorkbenchProjectNavigation();
  const currentlyPinnedEntries = useMemo(() => actions.projectThreadSummaries.projects.flatMap((summary) => {
    if (selectedProjectPinPlacement === "threads-section" && summary.projectId === projectId) return [];
    const project = projectsById.get(summary.projectId);
    return project ? summary.pinnedThreads.map((entry) => ({ entry, project })) : [];
  }), [actions.projectThreadSummaries.projects, projectId, projectsById, selectedProjectPinPlacement]);
  const currentEntries = useMemo(() => actions.projectThreadSidebars.projects.flatMap((sidebar) => {
    const project = projectsById.get(sidebar.projectId);
    if (!project) return [];
    return sidebar.entries.flatMap((entry): GlobalPinnedEntry[] => entry.entryKind === "subagent" ? [] : [{ entry, project }]);
  }), [actions.projectThreadSidebars.projects, projectsById]);
  const placement = useContextMenuPlacementSnapshot("thread-list", {
    displayOrder: actions.pinnedDisplayOrder,
    entries: currentlyPinnedEntries,
  });
  const layoutEntries = useMemo(() => placement.entries.map((entry) => ({
    key: displayKeyForGlobalEntry(entry),
    section: "pinned" as const,
  })), [placement.entries]);
  const placementItems = useMemo(() => projectThreadDisplayLayoutSection(
    placement.entries,
    layoutEntries,
    placement.displayOrder,
    "pinned",
    { preserveMissing: true },
  ), [layoutEntries, placement.displayOrder, placement.entries]);
  const items = mergePinnedDisplayItems(placementItems, currentEntries);
  const statusCounts = useMemo(
    () => WorkbenchThreadStatusCounts.countPinnedStatuses(currentlyPinnedEntries.map(({ entry }) => entry)),
    [currentlyPinnedEntries],
  );
  const priorityDropVisible = Boolean(
    isWorkbenchThreadRowDragPayload(activeDragPayload)
    && activeDragPayload.section !== "pinned"
    && activeDragPayload.section !== "settled",
  );
  if (!items.length && !priorityDropVisible) return null;

  const threadHref = (target: WorkbenchThreadTarget, ownerProjectId: string) => ownerProjectId === projectId
    ? projectHref(createThreadRoute(projectId, target))
    : projectHref(createPinnedThreadRoute(projectId, ownerProjectId, target));
  const renderEntry = ({ entry, project }: GlobalPinnedEntry) => {
    const target = targetForEntry(entry);
    const projectSourceKey = displayKeyForEntry(entry);
    const key = getProjectQualifiedThreadDisplayKey(project.id, projectSourceKey);
    const folder = findThreadDisplayFolder(placement.displayOrder, key);
    const targetIdentity = entry.entryKind === "thread" ? entry.identity : null;
    const targetReady = entry.entryKind === "thread"
      && entry.lifecycle.kind === "completed"
      && !(entry.gitArc?.claimedPaths.length);
    const dragTargets = (
      <WorkbenchThreadDragTargets
        activePayload={activeDragPayload}
        folderLabel={folder ? `add to ${folder.title}` : "create folder"}
        onFolderDrop={targetIdentity
          ? (payload) => actions.onPinnedFolderDrop(payload, project.id, projectSourceKey, folder?.folderId ?? null)
          : undefined}
        onSnoozeUntilDrop={targetIdentity && !targetReady
          ? (payload) => actions.onSnoozeUntil(payload, project.id, targetIdentity)
          : undefined}
        targetIdentity={targetIdentity}
        targetProjectId={project.id}
        targetTitle={entry.title}
      />
    );
    return (
      <Draggable
        dropTargetIds={[
          WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
          WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
          WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
        ]}
        key={key}
        label={entry.title}
        payload={{
          ownerProjectId: project.id,
          projectSourceKey,
          section: "pinned",
          sourceKey: key,
          target: { kind: "thread", target },
          type: "thread-row",
        }}
      >
        {({ draggable, onDragStart, onPointerDown }) => (
          <WorkbenchThreadListItem
            contextMenu={actions.getThreadContextMenu(entry, project.id, "pinned")}
            draggable={draggable}
            dragTargets={dragTargets}
            entry={entry}
            href={threadHref(target, project.id)}
            isDragActive={Boolean(activeDragPayload)}
            isShiftPressed={isShiftPressed}
            nowMs={actions.nowMs}
            onAction={(action) => actions.onAction(entry, action, project.id)}
            onActivate={(activatedTarget) => onOpenThread(activatedTarget, project.id)}
            onDragStart={onDragStart}
            onPointerDown={onPointerDown}
            project={project}
            projectId={project.id}
            selected={project.id === selectedOwnerProjectId && isWorkbenchThreadTargetSelected(target, currentTarget)}
            showActions={project.id === projectId || entry.entryKind !== "draft"}
          />
        )}
      </Draggable>
    );
  };
  const renderDropMarker = (key: string, destinationFolderId: string | null) => (
    <DropTarget
      as="li"
      className="m-0 list-none"
      dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
      key={`before:${destinationFolderId ?? "root"}:${key}`}
      range={THREAD_ORDER_DROP_RANGE}
      enabled={(payload) => isWorkbenchThreadRowDragPayload(payload)
        ? canMoveWorkbenchThreadRowToSection(payload, "pinned")
        : payload.type === "thread-folder"
        && payload.section === "pinned"
        && destinationFolderId === null}
      onDrop={(payload) => {
        if (isWorkbenchThreadRowDragPayload(payload)) {
          actions.onPinnedMove(
            getProjectQualifiedThreadDisplayKey(payload.ownerProjectId, payload.projectSourceKey),
            destinationFolderId,
            key || null,
          );
        } else if (payload.type === "thread-folder") actions.onPinnedMove(payload.sourceKey, destinationFolderId, key || null);
      }}
      preview={(payload) => isWorkbenchThreadRowDragPayload(payload)
        ? { action: "pinned", label: "move to pinned" }
        : null}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} data-thread-insertion-target="pinned" />}
    </DropTarget>
  );
  const renderFolder = (item: Extract<ThreadDisplayLayoutItem<GlobalPinnedEntry>, { itemKind: "folder" }>) => (
    <li className="m-0 list-none" key={getThreadDisplayFolderKey(item.folder.folderId)}>
      <WorkbenchThreadFolder
        activeDragPayload={activeDragPayload}
        autoFocusName={actions.autoFocusFolderId === item.folder.folderId}
        canPrependThread={(payload) => {
          const sourceKey = getProjectQualifiedThreadDisplayKey(payload.ownerProjectId, payload.projectSourceKey);
          return canMoveWorkbenchThreadRowToSection(payload, "pinned") && !item.folder.threadKeys.includes(sourceKey);
        }}
        entries={item.entries.map(({ entry }) => entry)}
        folder={item.folder}
        isDragActive={Boolean(activeDragPayload)}
        nowMs={actions.nowMs}
        onAutoFocusComplete={actions.onAutoFocusFolderComplete}
        onOpenChange={(open) => setFolderOpen("pinned", item.folder.folderId, open)}
        onPrependThread={(payload) => actions.onPinnedMove(
          getProjectQualifiedThreadDisplayKey(payload.ownerProjectId, payload.projectSourceKey),
          item.folder.folderId,
          item.folder.threadKeys[0] ?? null,
        )}
        onRename={(title) => actions.onRenamePinnedFolder(item.folder.folderId, title)}
        open={preferences.pinnedFolderIds.includes(item.folder.folderId)}
        tooltip={(
          <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
            {item.entries.map(({ entry, project }) => (
              <WorkbenchThreadListItem
                compact={false}
                dimmedOverride={false}
                entry={entry}
                href={threadHref(targetForEntry(entry), project.id)}
                key={`tooltip:${getProjectQualifiedThreadDisplayKey(project.id, displayKeyForEntry(entry))}`}
                nowMs={actions.nowMs}
                onActivate={(target) => onOpenThread(target, project.id)}
                project={project}
                projectId={project.id}
                showTooltip={false}
                tabIndex={-1}
              />
            ))}
          </ul>
        )}
      >
        <DropTargetBoundary className="min-w-0 px-1">
          <ul className="m-0 flex flex-col gap-0.5 p-0">
            {item.entries.flatMap((entry) => {
              const key = getProjectQualifiedThreadDisplayKey(entry.project.id, displayKeyForEntry(entry.entry));
              return [renderDropMarker(key, item.folder.folderId), renderEntry(entry)];
            })}
            {renderDropMarker("", item.folder.folderId)}
          </ul>
        </DropTargetBoundary>
      </WorkbenchThreadFolder>
    </li>
  );
  return (
    <DropTargetBoundary className="pb-3">
      <WorkbenchSidebarSectionDisclosure
        actions={<WorkbenchThreadStatusCountsButton counts={statusCounts} label="pinned thread" scope="pinned" />}
        contentClassName="mt-1"
        icon={PinIcon}
        preferenceKey="pinnedThreadsOpen"
        title="Pinned threads"
      >
        {items.length ? (
          <ul className="m-0 flex flex-col gap-0.5 p-0">
            {items.flatMap((item) => {
              const key = item.itemKind === "folder"
                ? getThreadDisplayFolderKey(item.folder.folderId)
                : getProjectQualifiedThreadDisplayKey(item.entry.project.id, displayKeyForEntry(item.entry.entry));
              return [renderDropMarker(key, null), item.itemKind === "folder" ? renderFolder(item) : renderEntry(item.entry)];
            })}
            {renderDropMarker("", null)}
          </ul>
        ) : (
          <WorkbenchThreadPriorityDropZone
            activePayload={activeDragPayload}
            onDrop={(payload) => actions.onSetPriority(payload, "pinned")}
            priority="pinned"
          />
        )}
      </WorkbenchSidebarSectionDisclosure>
    </DropTargetBoundary>
  );
}
