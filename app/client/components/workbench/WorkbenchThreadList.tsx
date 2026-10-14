/*
 * Exports:
 * - default WorkbenchThreadList: render the selected projects as one combined thread list with pinned, main, snoozed, and settled sections, from the listing's structure (rows read their own facts) or folder sidebars.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type {
  WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption, WorkbenchThreadListingSlot,
} from "workbench-shared/types";
import type { WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { useWorkbenchClientController } from "./workbench-client-context";
import { useThreads } from "./use-threads";

import {
  ProjectIdSchema, ProjectThreadDisplayKeySchema, type FolderId, type ProjectThreadDisplayKey,
} from "workbench-shared/workbench/identity";
import { createHomeThreadRoute, createLogicalThreadRoute, isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type {
  WorkspaceThreadPlacement, WorkspaceThreadPlacementItem,
} from "workbench-shared/workbench/workspace/workspace-observation";
import {
  getWorkbenchHomeFolderKey,
  getWorkbenchHomeThreadKey,
  projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayItem,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchThreadDisplayKey,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchThreadPriority, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type { WorkbenchThreadSidebarRow as WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-sidebar-row";
import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadDragSection,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import {
  mergeContextMenuPlacementEntries,
  useContextMenuPlacementSnapshot,
} from "./context-menu-placement";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import Disclosure from "../ui/Disclosure";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { CheckIcon, SnoozedThreadIcon, SparkleIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListRow, { targetForRowEntry, type ThreadListRowContext, type ThreadListRowEntry } from "./WorkbenchThreadListRow";
import { threadAttentionLabels } from "./thread-attention";
import { useProjects } from "./use-projects";
import WorkbenchThreadPriorityDropZone from "./WorkbenchThreadPriorityDropZone";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type ThreadActions = ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>;

type ListHomeEntry = ThreadListRowEntry;
type ListDisplayItem =
  | { entry: ListHomeEntry; itemKind: "thread"; threadKeys: [ProjectThreadDisplayKey] }
  | {
    entries: ListHomeEntry[];
    folder: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>["folder"];
    itemKind: "folder";
    projectId: string;
    threadKeys: ProjectThreadDisplayKey[];
  };
interface ThreadListShape {
  archivedEntries: ListHomeEntry[];
  mainEntries: ListHomeEntry[];
  pinnedItems: ListDisplayItem[];
  settledItems: ListDisplayItem[];
  snoozedItems: ListDisplayItem[];
}

/** The app server's placement for the selected projects, as slots; each row reads its own facts, pending or loaded. */
function listFromPlacement (
  placement: WorkspaceThreadPlacement,
  slots: Readonly<Record<string, WorkbenchThreadListingSlot>>,
  selectedProjectIds: readonly string[],
): ThreadListShape {
  const selected = new Set(selectedProjectIds);
  const entryFor = (key: string): ListHomeEntry[] => {
    const slot = slots[key];
    if (!slot?.logicalProjectId || !selected.has(slot.logicalProjectId)) return [];
    return [{ slot, projectId: slot.logicalProjectId, threadKey: ProjectThreadDisplayKeySchema.parse(key) }];
  };
  const items = (placed: readonly WorkspaceThreadPlacementItem[]): ListDisplayItem[] => placed.flatMap((item): ListDisplayItem[] => {
    if (item.kind === "thread") {
      return entryFor(item.key).map(entry => ({ entry, itemKind: "thread", threadKeys: [entry.threadKey] }));
    }
    if (!selected.has(item.projectId)) return [];
    const entries = item.keys.flatMap(entryFor);
    return entries.length ? [{
      entries, folder: item.folder, itemKind: "folder", projectId: item.projectId, threadKeys: entries.map(entry => entry.threadKey),
    }] : [];
  });
  return {
    archivedEntries: placement.archived.flatMap(entryFor),
    mainEntries: placement.main.flatMap(entryFor),
    pinnedItems: items(placement.pinned),
    settledItems: items(placement.settled),
    snoozedItems: items(placement.snoozed),
  };
}

/** A folder's header summarises its rows, so it reads those rows and their attention itself. */
function ListedThreadFolder ({ listEntries, ...props }: Omit<ComponentProps<typeof WorkbenchThreadFolder>, "entries" | "attentionLabelsByThreadId"> & {
  listEntries: readonly ListHomeEntry[];
}) {
  const listed = useThreads.rowsFor(listEntries.flatMap(entry => "slot" in entry ? [entry.threadKey] : []));
  const sidebars = useThreads.sidebars();
  const summaries = useProjects.threads();
  const attentionLabelsByThreadId = useMemo(() => threadAttentionLabels(sidebars, summaries), [sidebars, summaries]);
  const entries = useMemo(() => {
    const byKey = new Map(listed.map(row => [getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) as string, row.entry]));
    return listEntries.flatMap(entry => {
      const row = "entry" in entry ? entry.entry : byKey.get(entry.threadKey);
      return row && row.entryKind !== "subagent" ? [row] : [];
    });
  }, [listEntries, listed]);
  return <WorkbenchThreadFolder {...props} attentionLabelsByThreadId={attentionLabelsByThreadId} entries={entries} />;
}

function itemThreadCount (item: ListDisplayItem) {
  return item.threadKeys.length;
}

function itemKey (item: ListDisplayItem) {
  return item.itemKind === "folder"
    ? getWorkbenchHomeFolderKey(item.projectId, item.folder.folderId)
    : item.entry.threadKey;
}

function listEntries (list: ThreadListShape) {
  return [
    ...list.archivedEntries,
    ...list.mainEntries,
    ...list.pinnedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.settledItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.snoozedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
  ];
}

function mergeDisplayItems (
  items: ListDisplayItem[],
  currentEntries: readonly ListHomeEntry[],
) {
  const placementEntries = items.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]);
  const mergedByKey = new Map(mergeContextMenuPlacementEntries(
    placementEntries,
    currentEntries,
    entry => entry.threadKey,
  ).map(entry => [entry.threadKey, entry]));
  const current = (entry: ListHomeEntry) => mergedByKey.get(entry.threadKey) ?? entry;
  return items.map((item): ListDisplayItem => item.itemKind === "folder"
    ? { ...item, entries: item.entries.map(current) }
    : { ...item, entry: current(item.entry) });
}


export default function WorkbenchThreadList ({
  actions,
  activeDragPayload = null,
  allowMainPanelDrop = false,
  attachedDaemonId = null,
  canCreateThread,
  controls,
  createTarget = null,
  createThreadLabel = "Create new thread",
  currentTarget,
  folderSidebars,
  getThreadHref,
  logicalProjects,
  onAttachFeedback,
  onCreateThread,
  onCreateThreadPointerDragStart,
  onOpenQualifiedThread,
  onOpenThread,
  presentation,
  projectId,
  projects,
  renderThreadTooltipDetails,
  selectedOwnerProjectId,
  selectedProjectIds,
}: {
  actions: ThreadActions;
  activeDragPayload?: WorkbenchDragPayload | null;
  allowMainPanelDrop?: boolean;
  attachedDaemonId?: string | null;
  canCreateThread?: boolean;
  controls?: WorkbenchControls | null;
  createTarget?: {
    location: ProjectLocationReference | null;
    project: WorkbenchProjectOption | WorkbenchLogicalProject;
  } | null;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  /** Folder-sidebar lists (no app presentation) are built from these sidebars; logical lists read the listing. */
  folderSidebars?: {
    sidebars: WorkbenchProjectThreadSidebars;
    homeDisplayOrder: WorkbenchThreadDisplayOrder;
    homeDisplayOrderSupported: boolean;
    /** Single-project feed. When supplied it stands in for one project inside the combined list. */
    current?: { entries: WorkbenchThreadSidebarEntry[]; displayOrder: WorkbenchThreadDisplayOrder };
  };
  getThreadHref?: (target: WorkbenchThreadTarget, ownerProjectId?: string) => string | undefined;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  onAttachFeedback?: (
    ownerProjectId: string,
    target: WorkbenchThreadTarget,
    reference: WorkbenchThreadAddressedFeedback,
  ) => Promise<void>;
  onCreateThread: (ownerProjectId: string, options?: {
    folderId?: FolderId;
    location?: ProjectLocationReference;
  }) => void;
  onCreateThreadPointerDragStart?: (event: import("react").PointerEvent<HTMLAnchorElement>) => void;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  presentation?: PresentationSnapshot | null;
  projectId?: string;
  projects: readonly (WorkbenchProjectOption | WorkbenchLogicalProject)[];
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
  selectedProjectIds: readonly string[];
}) {
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [layoutError, setLayoutError] = useState("");
  const isShiftPressed = useNonTextInputShiftKey();
  const client = useWorkbenchClientController();
  const projectHref = useWorkbenchProjectNavigation();
  const {
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setSettledThreadItemLimit,
  } = useWorkbenchSidebarPreferences();
  const homeDisplayOrderSupported = Boolean(logicalProjects && presentation && controls)
    || Boolean(folderSidebars?.homeDisplayOrderSupported);
  const showProjectEyebrow = selectedProjectIds.length > 1;
  const projectsById = useMemo(() => new Map<string, WorkbenchProjectOption | WorkbenchLogicalProject>(
    (logicalProjects ?? projects).map(project => [project.id, project] as const),
  ), [logicalProjects, projects]);
  // The list reads only its structure; each row reads its own facts, so one thread's activity re-renders one row.
  const structure = useThreads.structure();
  const listedArchivedCount = useThreads.archivedCount();
  const currentList = useMemo((): ThreadListShape => {
    // Logical lists are placed by the app server; until membership arrives there is nothing to place.
    if (logicalProjects && presentation) {
      return structure.placement
        ? listFromPlacement(structure.placement, structure.slots, selectedProjectIds)
        : { archivedEntries: [], mainEntries: [], pinnedItems: [], settledItems: [], snoozedItems: [] };
    }
    return projectWorkbenchHomeThreadList({
      projects: folderSidebars?.current && projectId
        ? [{ projectId, entries: folderSidebars.current.entries, displayOrder: folderSidebars.current.displayOrder }]
        : (folderSidebars?.sidebars.projects ?? []).filter(sidebar => selectedProjectIds.includes(sidebar.projectId)),
    }, folderSidebars?.homeDisplayOrder ?? {});
  }, [folderSidebars, logicalProjects, presentation, projectId, selectedProjectIds, structure]);
  const readRows = () => client.mounted?.threadSidebar.getListing?.().rows ?? [];
  const rowForPayload = (payload: WorkbenchThreadRowDragPayload) => readRows().find(row =>
    getWorkbenchThreadDisplayKey(row.entry) === payload.projectSourceKey
    && (row.logicalProjectId === payload.ownerProjectId
      || row.location.projectId === payload.ownerProjectId));
  const keyForPayload = (payload: WorkbenchThreadRowDragPayload) => {
    if (payload.type === "home-thread-row") return payload.sourceKey;
    if (!logicalProjects) return getProjectQualifiedThreadDisplayKey(
      payload.ownerProjectId, payload.projectSourceKey,
    );
    const row = rowForPayload(payload);
    return row ? getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) : null;
  };
  const moveHome = async (
    sourceKey: string, section: WorkbenchThreadDisplaySection,
    destinationFolderKey: string | null, beforeKey: string | null,
  ) => {
    if (!controls) {
      actions.onHomeMove(sourceKey, section, destinationFolderKey, beforeKey);
      return;
    }
    try {
      await controls.updatePresentationHomeLayout({ sourceKey, section, destinationFolderKey, beforeKey });
      setLayoutError("");
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Home layout could not be saved.";
      setLayoutError(message);
      console.error("Home layout move failed", message);
    }
  };
  const updateProjectLayout = async (
    logicalProjectId: WorkbenchLogicalProject["id"],
    intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[1],
  ) => {
    if (!controls) return false;
    try {
      await controls.updatePresentationProjectLayout(logicalProjectId, intent);
      setLayoutError("");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Project folder could not be saved.";
      setLayoutError(message);
      console.error("Project folder update failed", message);
      return false;
    }
  };
  const placementList = useContextMenuPlacementSnapshot("thread-list", currentList);
  const currentEntries = listEntries(currentList);
  const list = {
    ...placementList,
    archivedEntries: mergeContextMenuPlacementEntries(
      placementList.archivedEntries,
      currentEntries,
      entry => entry.threadKey,
    ),
    mainEntries: mergeContextMenuPlacementEntries(
      placementList.mainEntries,
      currentEntries,
      entry => entry.threadKey,
    ),
    pinnedItems: mergeDisplayItems(placementList.pinnedItems, currentEntries),
    settledItems: mergeDisplayItems(placementList.settledItems, currentEntries),
    snoozedItems: mergeDisplayItems(placementList.snoozedItems, currentEntries),
  };
  const archivedPlacementKeys = new Set(placementList.archivedEntries.map(entry => entry.threadKey));
  const settledLimit = preferences.settledThreadItemLimit;
  const historyItems: ListDisplayItem[] = [
    ...list.settledItems,
    ...list.archivedEntries.map(entry => ({ entry, itemKind: "thread" as const, threadKeys: [entry.threadKey] as [ProjectThreadDisplayKey] })),
  ];
  let settledThreadCount = 0;
  const displayedHistoryItems = historyItems.filter((item, index) => {
    const count = itemThreadCount(item);
    if (settledThreadCount >= settledLimit && index > 0) return false;
    settledThreadCount += count;
    return true;
  });
  const displayedSettledThreadCount = displayedHistoryItems.reduce((count, item) => count + itemThreadCount(item), 0);
  // Archived rows load in pages; count every archived thread so "Load more" reaches the unloaded ones.
  const archivedThreadCount = Math.max(list.archivedEntries.length, listedArchivedCount);
  const historyThreadCount = historyItems.reduce((count, item) => count + itemThreadCount(item), 0)
    - list.archivedEntries.length + archivedThreadCount;
  const remainingSettledThreadCount = historyThreadCount - displayedSettledThreadCount;
  const archivedDemand = preferences.settledThreadsOpen && archivedThreadCount ? settledLimit : null;
  useEffect(() => {
    if (!controls || archivedDemand === null) return;
    controls.setArchivedThreadLimit(archivedDemand);
    return () => controls.setArchivedThreadLimit(null);
  }, [archivedDemand, controls]);
  const nextSettledThreadCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledThreadCount);
  const isDragActive = Boolean(activeDragPayload);
  const visibleRows = (items: ListDisplayItem[]) => items.flatMap(item => item.itemKind === "folder"
    ? preferences.threadFolderIds.includes(itemKey(item)) ? item.entries : []
    : [item.entry]);
  const navigableEntries = [
    ...visibleRows(list.pinnedItems),
    ...list.mainEntries,
    ...(preferences.snoozedThreadsOpen ? visibleRows(list.snoozedItems) : []),
    ...(preferences.settledThreadsOpen ? visibleRows(displayedHistoryItems) : []),
  ];
  const hasSelectedEntry = navigableEntries.some((homeEntry) =>
    isWorkbenchThreadTargetSelected(targetForRowEntry(homeEntry), currentTarget));
  const focusRow = (event: ReactKeyboardEvent<HTMLAnchorElement>, threadKey: string) => {
    const index = navigableEntries.findIndex(entry => entry.threadKey === threadKey);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(navigableEntries.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = navigableEntries.length - 1;
    else return;
    event.preventDefault();
    const nextEntry = navigableEntries[next];
    if (nextEntry) rowRefs.current.get(nextEntry.threadKey)?.focus();
  };
  const rowContext: ThreadListRowContext = {
    actions, activeDragPayload, allowMainPanelDrop, attachedDaemonId, controls, currentTarget, focusRow, getThreadHref, hasSelectedEntry,
    firstThreadKey: navigableEntries[0]?.threadKey ?? null, homeDisplayOrderSupported, isShiftPressed, logicalProjects,
    onAttachFeedback, onOpenQualifiedThread, onOpenThread, projectHref, projectsById, readRowForPayload: rowForPayload,
    registerRow: (threadKey, node) => { if (node) rowRefs.current.set(threadKey, node); else rowRefs.current.delete(threadKey); },
    renderThreadTooltipDetails, selectedOwnerProjectId, setLayoutError, showProjectEyebrow, updateProjectLayout,
  };

  const renderEntry = (
    listEntry: ListHomeEntry,
    reorderSection?: WorkbenchThreadDisplaySection,
    placementFolder: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>["folder"] | null = null,
    placementSection?: WorkbenchThreadDragSection | "archived",
  ) => (
    <WorkbenchThreadListRow
      context={rowContext}
      key={listEntry.threadKey}
      listEntry={listEntry}
      placementFolder={placementFolder}
      placementSection={placementSection}
      reorderSection={reorderSection}
    />
  );

  const renderDropMarker = (
    key: string,
    beforeKey: string | null,
    section: WorkbenchThreadDisplaySection,
    destinationFolderKey: string | null,
    destinationProjectId: string | null,
  ) => homeDisplayOrderSupported ? (
    <DropTarget
      as="li"
      className="m-0 list-none"
      dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
      key={`before:${destinationFolderKey ?? "root"}:${key}`}
      range={THREAD_ORDER_DROP_RANGE}
      enabled={(payload) => isWorkbenchThreadRowDragPayload(payload)
        ? canMoveWorkbenchThreadRowToSection(
          payload,
          section,
          destinationFolderKey === null ? undefined : destinationProjectId ?? undefined,
        )
        : payload.type === "home-thread-folder"
        && payload.section === section
        && destinationFolderKey === null}
      onDrop={(payload) => {
        if (isWorkbenchThreadRowDragPayload(payload)) {
          const dropKey = keyForPayload(payload);
          if (dropKey) void moveHome(dropKey, section, destinationFolderKey, beforeKey);
        } else if (payload.type === "home-thread-folder") {
          void moveHome(payload.sourceKey, section, destinationFolderKey, beforeKey);
        }
      }}
      preview={(payload) => isWorkbenchThreadRowDragPayload(payload) && section !== "settled"
        ? { action: section, label: `move to ${section}` }
        : null}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} data-thread-insertion-target={section} />}
    </DropTarget>
  ) : null;

  const renderFolderTooltip = (item: Extract<ListDisplayItem, { itemKind: "folder" }>) => (
    <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
      {item.entries.map((listEntry) => (
        <WorkbenchThreadListRow context={rowContext} key={`tooltip:${listEntry.threadKey}`} listEntry={listEntry} presentation="preview" />
      ))}
    </ul>
  );

  const renderFolderCreateThread = (item: Extract<ListDisplayItem, { itemKind: "folder" }>) => {
    const target = { folderId: item.folder.folderId, kind: "new" as const };
    const logicalProject = logicalProjects?.find(project => project.id === item.projectId);
    if (client.mounted?.presentationClient && !logicalProject) return null;
    const location = logicalProject?.locations.find(candidate => candidate.project)?.target
      ?? logicalProject?.locations[0]?.target ?? null;
    const selected = item.projectId === selectedOwnerProjectId
      && isWorkbenchThreadTargetSelected(target, currentTarget);
    return (
      <a
        href={getThreadHref ? getThreadHref(target, item.projectId) : projectHref(logicalProject
          ? createLogicalThreadRoute(null, logicalProject.id, location, target)
          : createHomeThreadRoute(item.projectId, target))}
        title={createThreadLabel}
        aria-current={selected ? "page" : undefined}
        className={`
          ${workbenchOptionRowClassName} min-h-9 w-full md:min-h-8
          ${selected ? `${workbenchOptionSelectedClassName} font-semibold text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
        `}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(item.projectId, { folderId: item.folder.folderId });
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="shrink-0" size={16} />
          <span className={`${workbenchThreadListLabelClassName}${selected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a>
    );
  };

  const renderFolderEntries = (item: Extract<ListDisplayItem, { itemKind: "folder" }>) => {
    const folderKey = getWorkbenchHomeFolderKey(item.projectId, item.folder.folderId);
    return (
      <DropTargetBoundary className="min-w-0 px-1">
        <ul className="m-0 flex flex-col gap-0.5 p-0">
          {item.entries.flatMap((entry) => [
            renderDropMarker(entry.threadKey, entry.threadKey, item.folder.section, folderKey, item.projectId),
            renderEntry(entry, item.folder.section, item.folder),
          ])}
          {renderDropMarker("", null, item.folder.section, folderKey, item.projectId)}
        </ul>
      </DropTargetBoundary>
    );
  };

  const renderSection = (items: ListDisplayItem[], section: WorkbenchThreadDisplaySection) => (
    <ul className="m-0 flex flex-col gap-0.5 p-0">
      {items.flatMap((item) => {
        const key = itemKey(item);
        const beforeKey = item.threadKeys[0] ?? null;
        if (item.itemKind === "thread") {
          return [
            renderDropMarker(key, beforeKey, section, null, null),
            renderEntry(item.entry, section),
          ];
        }
        const project = projectsById.get(item.projectId) ?? null;
        if (!project && showProjectEyebrow) return [];
        return [
          renderDropMarker(key, beforeKey, section, null, null),
          <li className="m-0 list-none" key={key}>
            <ListedThreadFolder
              activeDragPayload={activeDragPayload}
              autoFocusName={actions.autoFocusFolderId === item.folder.folderId}
              canPrependThread={(payload) => canMoveWorkbenchThreadRowToSection(payload, section, item.projectId)
                && !item.folder.threadKeys.includes(payload.projectSourceKey)}
              listEntries={item.entries}
              folder={item.folder}
              homeFolderKey={key}
              isDragActive={isDragActive}
              onAutoFocusComplete={actions.onAutoFocusFolderComplete}
              onOpenChange={(open) => setFolderOpen("threads", key, open)}
              onPrependThread={(payload) => {
                const sourceKey = keyForPayload(payload);
                if (sourceKey) void moveHome(sourceKey, section, key, item.entries[0]?.threadKey ?? null);
              }}
              onRename={async (title) => {
                if (!logicalProjects) {
                  return await actions.onRenameFolder(
                    item.folder.folderId, title, ProjectIdSchema.parse(item.projectId),
                  );
                }
                const project = logicalProjects.find(candidate => candidate.id === item.projectId);
                if (!project || !await updateProjectLayout(project.id, {
                  kind: "rename", folderId: item.folder.folderId, title,
                })) throw new Error("Project folder rename could not be saved.");
                return title.trim();
              }}
              open={preferences.threadFolderIds.includes(key)}
              project={project ?? undefined}
              tooltip={renderFolderTooltip(item)}
            >
              {section === "settled" ? null : renderFolderCreateThread(item)}
              {renderFolderEntries(item)}
            </ListedThreadFolder>
          </li>,
        ];
      })}
      {renderDropMarker("", null, section, null, null)}
    </ul>
  );

  const priorityTarget = (priority: WorkbenchThreadPriority) => (
    <WorkbenchThreadPriorityDropZone
      activePayload={activeDragPayload}
      onDrop={(payload) => {
        if (!logicalProjects || !controls) {
          actions.onSetPriority(payload, priority);
          return;
        }
        const row = rowForPayload(payload);
        if (!row) return;
        const key = getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry);
        if (priority !== "main") {
          void moveHome(key, priority, null, null);
          return;
        }
        const mutation = row.entry.entryKind === "draft"
          ? controls.setPresentationDraftPriority(row.entry.draft.draftId, {
            pinned: false, snoozed: false,
          })
          : controls.threadAction(row.entry.identity.threadId, { kind: "priority", priority });
        void mutation.catch(error => {
          const message = error instanceof Error ? error.message.slice(0, 500) : "Thread priority could not be saved.";
          setLayoutError(message);
          console.error("Thread priority failed", message);
        });
      }}
      priority={priority}
    />
  );

  const resolvedCreateProject =
    createTarget?.project ?? projectsById.get(selectedOwnerProjectId) ?? null;
  const canCreate = canCreateThread ?? Boolean(client.mounted && (!client.mounted.presentationClient
    || resolvedCreateProject && "matchKey" in resolvedCreateProject
    && resolvedCreateProject.locations.some(location => location.project)));
  const createLocation = createTarget?.location ?? (resolvedCreateProject && "matchKey" in resolvedCreateProject
    ? resolvedCreateProject.locations.find(location => location.project)?.target ?? null : null);
  const createProjectId = createLocation?.projectId ?? resolvedCreateProject?.id ?? "";
  const blankThreadSelected = resolvedCreateProject?.id === selectedOwnerProjectId
    && isWorkbenchThreadTargetSelected({ kind: "new" }, currentTarget);
  return (
    <DropTargetBoundary className="space-y-1">
      {resolvedCreateProject && canCreate ? <a
        href={getThreadHref ? getThreadHref({ kind: "new" }, createProjectId) : projectHref("matchKey" in resolvedCreateProject
          ? createLogicalThreadRoute(null, resolvedCreateProject.id, createLocation, { kind: "new" })
          : createHomeThreadRoute(resolvedCreateProject.id, { kind: "new" }))}
        title={createThreadLabel}
        aria-current={blankThreadSelected ? "page" : undefined}
        className={`
          ${workbenchOptionRowClassName} mt-1 min-h-9 w-full md:min-h-8
          ${blankThreadSelected ? `${workbenchOptionSelectedClassName} font-semibold text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
        `}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(createProjectId, createLocation ? { location: createLocation } : undefined);
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onCreateThreadPointerDragStart?.(event);
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="shrink-0" size={16} />
          <span className={`${workbenchThreadListLabelClassName}${blankThreadSelected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </a> : canCreate ? null : <div className="px-2 py-2 text-[0.78rem] text-fg/muted">
        {client.mounted?.presentationClient && logicalProjects?.length
          ? "Project folder unavailable" : "Waiting for project identities"}
      </div>}
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {list.pinnedItems.length ? renderSection(list.pinnedItems, "pinned") : priorityTarget("pinned")}
        {priorityTarget("main")}
        {list.mainEntries.length
          ? <ul className="m-0 flex flex-col gap-1 p-0">{list.mainEntries.map((entry) => renderEntry(entry, undefined, null, "main"))}</ul>
          : null}
        {list.snoozedItems.length ? (
          <Disclosure
            className="mt-2"
            keepMounted
            hideChevron={true}
            open={preferences.snoozedThreadsOpen}
            onToggle={(event) => setDisclosureOpen("snoozedThreadsOpen", event.currentTarget.open)}
            summary={<span className="inline-flex items-center gap-2"><SnoozedThreadIcon /><span>Snoozed threads</span></span>}
            summaryClassName="pl-2 text-[0.72rem] font-medium leading-[1.5] text-fg/muted"
          >
            {renderSection(list.snoozedItems, "snoozed")}
          </Disclosure>
        ) : priorityTarget("snoozed")}
        {historyItems.length || archivedThreadCount ? (
          <Disclosure
            className="mt-2"
            hideChevron={true}
            open={preferences.settledThreadsOpen}
            onToggle={(event) => setDisclosureOpen("settledThreadsOpen", event.currentTarget.open)}
            summary={<span className="inline-flex items-center gap-2"><CheckIcon /><span>Settled threads</span></span>}
            summaryClassName="pl-2 text-[0.72rem] font-medium leading-[1.5] text-fg/muted"
          >
            {renderSection(displayedHistoryItems.filter(item => item.itemKind === "folder" || !archivedPlacementKeys.has(item.entry.threadKey)), "settled")}
            {displayedHistoryItems.some(item => item.itemKind === "thread" && archivedPlacementKeys.has(item.entry.threadKey)) ? (
              <h3 className="mt-4 mb-1 text-[0.72rem] font-medium text-fg/muted">Archived threads</h3>
            ) : null}
            <ul className="m-0 flex flex-col gap-1 p-0">
              {displayedHistoryItems.flatMap(item => item.itemKind === "thread" && archivedPlacementKeys.has(item.entry.threadKey) ? [renderEntry(item.entry, undefined, null, "archived")] : [])}
            </ul>
            {remainingSettledThreadCount > 0 ? (
              <button
                type="button"
                aria-label={`Load ${nextSettledThreadCount} more historical threads`}
                className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-fg/muted`}
                onClick={() => setSettledThreadItemLimit(preferences.settledThreadItemLimit + SETTLED_THREAD_PAGE_SIZE)}
              >
                Load {nextSettledThreadCount} more
              </button>
            ) : null}
          </Disclosure>
        ) : null}
      </div>
      {layoutError ? <p role="alert" className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">{layoutError}</p> : null}
    </DropTargetBoundary>
  );
}
