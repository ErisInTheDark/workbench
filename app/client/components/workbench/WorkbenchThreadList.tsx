/*
 * Exports:
 * - default WorkbenchThreadList: render the selected projects as one combined thread list with pinned, main, snoozed, and settled sections.
 */
"use client";

import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import { useWorkbenchClientController } from "./workbench-client-context";

import { ProjectIdSchema, type FolderId, type ProjectThreadDisplayKey } from "workbench-shared/workbench/identity";
import { createHomeThreadRoute, createLogicalExistingThreadRoute, createLogicalThreadRoute, isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import {
  projectLogicalHomeDisplayOrder,
  projectLogicalThreadDisplayOrder,
} from "workbench-shared/workbench/project/workbench-project-projection";
import {
  getWorkbenchHomeFolderKey,
  getWorkbenchHomeThreadKey,
  projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayItem,
  type WorkbenchHomeThreadEntry,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchThreadDisplayKey,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import type { WorkbenchThreadPriority, WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_MAIN_PANEL_DROP_TARGET_ID,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadDragSection,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import {
  mergeContextMenuPlacementEntries,
  useContextMenuPlacementSnapshot,
} from "./context-menu-placement";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { CheckIcon, SnoozedThreadIcon, SparkleIcon } from "./workbench-icons";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadPriorityDropZone from "./WorkbenchThreadPriorityDropZone";
import WorkbenchThreadReferenceList from "./WorkbenchThreadReferenceList";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type ThreadActions = ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>;

function targetForEntry (entry: WorkbenchThreadSidebarEntry): import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function itemThreadCount (item: WorkbenchHomeThreadDisplayItem) {
  return item.threadKeys.length;
}

function itemKey (item: WorkbenchHomeThreadDisplayItem) {
  return item.itemKind === "folder"
    ? getWorkbenchHomeFolderKey(item.projectId, item.folder.folderId)
    : item.entry.threadKey;
}

function listEntries (list: ReturnType<typeof projectWorkbenchHomeThreadList>) {
  return [
    ...list.archivedEntries,
    ...list.mainEntries,
    ...list.pinnedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.settledItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.snoozedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
  ];
}

function mergeDisplayItems (
  items: WorkbenchHomeThreadDisplayItem[],
  currentEntries: readonly WorkbenchHomeThreadEntry[],
) {
  const placementEntries = items.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]);
  const mergedByKey = new Map(mergeContextMenuPlacementEntries(
    placementEntries,
    currentEntries,
    entry => entry.threadKey,
  ).map(entry => [entry.threadKey, entry]));
  const current = (entry: WorkbenchHomeThreadEntry) => mergedByKey.get(entry.threadKey) ?? entry;
  return items.map(item => item.itemKind === "folder"
    ? { ...item, entries: item.entries.map(current) }
    : { ...item, entry: current(item.entry) });
}

export default function WorkbenchThreadList ({
  actions,
  activeDragPayload = null,
  allowMainPanelDrop = false,
  attentionLabelsByThreadId = {},
  attachedDaemonId,
  canCreateThread,
  controls,
  createProject = null,
  createThreadLabel = "Create new thread",
  currentTarget,
  displayOrder,
  entries,
  getThreadHref,
  logicalProjects,
  logicalThreads,
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
  attentionLabelsByThreadId?: Record<string, string | undefined>;
  attachedDaemonId?: string | null;
  canCreateThread?: boolean;
  controls?: WorkbenchControls | null;
  createProject?: WorkbenchProjectOption | WorkbenchLogicalProject | null;
  createThreadLabel?: string;
  currentTarget: WorkbenchThreadTarget | null;
  /** Single-project feed. When supplied it stands in for one project inside the combined list. */
  displayOrder?: WorkbenchThreadDisplayOrder;
  entries?: WorkbenchThreadSidebarEntry[];
  getThreadHref?: (target: WorkbenchThreadTarget, ownerProjectId?: string) => string | undefined;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  onCreateThread: (ownerProjectId: string, folderId?: FolderId) => void;
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
    || actions.homeDisplayOrderSupported;
  const showProjectEyebrow = selectedProjectIds.length > 1;
  const projectsById = useMemo(() => new Map<string, WorkbenchProjectOption | WorkbenchLogicalProject>(
    (logicalProjects ?? projects).map(project => [project.id, project] as const),
  ), [logicalProjects, projects]);
  const currentList = useMemo(() => projectWorkbenchHomeThreadList(
    logicalProjects && presentation ? {
      projects: logicalProjects.filter(project => selectedProjectIds.includes(project.id)).map(project => ({
        projectId: project.id,
        entries: (logicalThreads ?? []).filter(row => row.logicalProjectId === project.id).map(row => row.entry),
        displayOrder: projectLogicalThreadDisplayOrder(project.id, logicalThreads ?? [], presentation),
      })),
    } : {
      projects: entries && displayOrder && projectId
        ? [{ projectId, entries, displayOrder }]
        : actions.projectThreadSidebars.projects.filter(sidebar => selectedProjectIds.includes(sidebar.projectId)),
    },
    logicalProjects && presentation
      ? projectLogicalHomeDisplayOrder(logicalThreads ?? [], presentation)
      : actions.homeDisplayOrder,
  ), [actions.homeDisplayOrder, actions.projectThreadSidebars, displayOrder, entries, logicalProjects, logicalThreads, presentation, projectId, selectedProjectIds]);
  const qualifiedFor = (homeEntry: WorkbenchHomeThreadEntry) => logicalProjects
    ? logicalThreads?.find(row => row.logicalProjectId === homeEntry.projectId
      && getWorkbenchThreadDisplayKey(row.entry) === getWorkbenchThreadDisplayKey(homeEntry.entry))
    : attachedDaemonId ? logicalThreads?.find(row => row.location.daemonId === attachedDaemonId
      && row.location.projectId === homeEntry.projectId
      && getWorkbenchThreadDisplayKey(row.entry) === getWorkbenchThreadDisplayKey(homeEntry.entry)) : null;
  const rowForPayload = (payload: WorkbenchThreadRowDragPayload) => logicalThreads?.find(row =>
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
    intent: Parameters<WorkbenchControls["updatePresentationProjectLayout"]>[2],
  ) => {
    if (!controls || !logicalThreads) return false;
    try {
      await controls.updatePresentationProjectLayout(logicalProjectId, logicalThreads, intent);
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
  const historyItems: WorkbenchHomeThreadDisplayItem[] = [
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
  const remainingSettledThreadCount = historyItems.reduce((count, item) => count + itemThreadCount(item), 0) - displayedSettledThreadCount;
  const nextSettledThreadCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledThreadCount);
  const isDragActive = Boolean(activeDragPayload);
  const visibleRows = (items: WorkbenchHomeThreadDisplayItem[]) => items.flatMap(item => item.itemKind === "folder"
    ? preferences.threadFolderIds.includes(itemKey(item)) ? item.entries : []
    : [item.entry]);
  const navigableEntries = [
    ...visibleRows(list.pinnedItems),
    ...list.mainEntries,
    ...(preferences.snoozedThreadsOpen ? visibleRows(list.snoozedItems) : []),
    ...(preferences.settledThreadsOpen ? visibleRows(displayedHistoryItems) : []),
  ];
  const hasSelectedEntry = navigableEntries.some((homeEntry) =>
    isWorkbenchThreadTargetSelected(targetForEntry(homeEntry.entry), currentTarget));
  const moveFocus = (event: ReactKeyboardEvent<HTMLAnchorElement>, index: number) => {
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

  const renderEntry = (
    homeEntry: WorkbenchHomeThreadEntry,
    reorderSection?: WorkbenchThreadDisplaySection,
    placementFolder: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>["folder"] | null = null,
    placementSection?: WorkbenchThreadDragSection | "archived",
  ) => {
    const { entry, projectId: entryProjectId, threadKey } = homeEntry;
    const project = projectsById.get(entryProjectId) ?? null;
    if (!project && showProjectEyebrow) return null;
    const target = targetForEntry(entry);
    const qualified = qualifiedFor(homeEntry);
    const logicalProject = qualified && logicalProjects?.find(item => item.id === qualified.logicalProjectId);
    const sourceProjectId = qualified?.location.projectId ?? ProjectIdSchema.parse(entryProjectId);
    const projectSourceKey = getWorkbenchThreadDisplayKey(entry);
    const frozenSection = placementSection ?? reorderSection
      ?? (entry.metadata.pinned ? "pinned" : "main");
    const dragSection: WorkbenchThreadDragSection = frozenSection === "archived" ? "main" : frozenSection;
    const archived = frozenSection === "archived";
    const targetIdentity = entry.entryKind === "thread" ? entry.identity : null;
    const targetReady = entry.entryKind === "thread"
      && entry.lifecycle.kind === "completed"
      && !(entry.gitArc?.claimedPaths.length);
    const folderDropEnabled = Boolean(
      isWorkbenchThreadRowDragPayload(activeDragPayload)
      && targetIdentity
      && reorderSection
      && activeDragPayload.ownerProjectId === entryProjectId
      && (reorderSection !== "settled" || activeDragPayload.section === "settled"),
    );
    const readOnly = Boolean(qualified?.observedOnly);
    const dragTargets = archived || readOnly ? null : (
      <WorkbenchThreadDragTargets
        activePayload={activeDragPayload}
        folderLabel={placementFolder ? `add to ${placementFolder.title}` : "create folder"}
        onFolderDrop={folderDropEnabled && reorderSection
          ? (payload) => {
            if (logicalProjects && qualified) {
              const source = rowForPayload(payload);
              if (source?.logicalProjectId !== qualified.logicalProjectId) {
                setLayoutError("A folder cannot combine different project identities.");
                return;
              }
              void updateProjectLayout(qualified.logicalProjectId, {
                kind: "drop", section: reorderSection, sourceKey: payload.projectSourceKey,
                targetKey: projectSourceKey, destinationFolderId: placementFolder?.folderId ?? null,
              });
            } else if (!logicalProjects) {
              actions.onProjectFolderDrop(
                payload, sourceProjectId, projectSourceKey, reorderSection, placementFolder?.folderId ?? null,
              );
            }
          }
          : undefined}
        onSnoozeUntilDrop={targetIdentity
          ? (payload) => {
            if (!logicalProjects) {
              actions.onSnoozeUntil(payload, sourceProjectId, targetIdentity);
              return;
            }
            const source = rowForPayload(payload);
            if (!source || !qualified || payload.target.target.kind !== "provider") {
              setLayoutError("Dependent snooze needs two existing threads.");
              return;
            }
            void controls?.threadAction(payload.target.target.threadId, {
              kind: "snoozeUntil", targetThreadId: targetIdentity.threadId,
            }).catch(error => {
              const message = error instanceof Error ? error.message.slice(0, 500) : "Dependent snooze failed.";
              setLayoutError(message);
              console.error("Dependent snooze failed", message);
            });
          }
          : undefined}
        targetIdentity={targetIdentity}
        targetProjectId={ProjectIdSchema.parse(entryProjectId)}
        targetReady={targetReady}
        targetTitle={entry.title}
      />
    );
    const renderRow = ({ draggable, onDragStart, onPointerDown }: {
      draggable: false;
      onDragStart: import("react").DragEventHandler<HTMLElement>;
      onPointerDown: import("react").PointerEventHandler<HTMLElement>;
    }) => {
      const index = navigableEntries.indexOf(homeEntry);
      return (
        <WorkbenchThreadListItem
          anchorRef={(node: HTMLAnchorElement | null) => { if (node) rowRefs.current.set(threadKey, node); else rowRefs.current.delete(threadKey); }}
          attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
          compact={false}
          contextMenu={readOnly ? null : qualified
            ? actions.getThreadContextMenuFor(entry, "project")
            : logicalProjects ? null : actions.getThreadContextMenu(entry, sourceProjectId, "project")}
          draggable={draggable && !readOnly}
          dragTargets={dragTargets}
          entry={entry}
          href={getThreadHref ? getThreadHref(target, sourceProjectId) : projectHref(qualified
            ? target.kind === "provider"
              ? createLogicalExistingThreadRoute(null, target)
              : createLogicalThreadRoute(null, qualified.logicalProjectId, qualified.location, target)
            : createHomeThreadRoute(entryProjectId, target))}
          isDragActive={isDragActive}
          isShiftPressed={isShiftPressed}
          onKeyDown={(event) => moveFocus(event, index)}
          onAction={(action) => readOnly ? undefined : qualified
            ? actions.onActionFor(entry, action)
            : actions.onAction(entry, action, sourceProjectId)}
          onActivate={(activatedTarget) => qualified
            ? onOpenQualifiedThread?.(qualified) : onOpenThread(activatedTarget, sourceProjectId)}
          onDragStart={readOnly ? undefined : onDragStart}
          onPointerDown={readOnly ? undefined : onPointerDown}
          project={showProjectEyebrow ? logicalProject ?? project ?? undefined : undefined}
          projectId={sourceProjectId}
          role="tab"
          selected={entryProjectId === selectedOwnerProjectId
            && isWorkbenchThreadTargetSelected(target, currentTarget)}
          showActions={!readOnly}
          showPinPriorityIcon
          tabIndex={isWorkbenchThreadTargetSelected(target, currentTarget) || (!hasSelectedEntry && index === 0) ? 0 : -1}
          tooltipDetails={<>
            {renderThreadTooltipDetails?.(entry)}
            {entry.entryKind === "thread" && entry.waitingOnThreads?.length
              ? <WorkbenchThreadReferenceList label="Waiting for" references={entry.waitingOnThreads} /> : null}
          </>}
        />
      );
    };
    return (
      <Draggable
        disabled={archived || readOnly}
        dropTargetIds={[
          ...(homeDisplayOrderSupported ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID] : []),
          WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
          WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
          ...(allowMainPanelDrop ? [WORKBENCH_MAIN_PANEL_DROP_TARGET_ID] : []),
        ]}
        key={threadKey}
        label={entry.title}
        payload={archived || readOnly
          ? { target: { kind: "thread", target }, type: "panel-target" }
          : {
            ownerProjectId: ProjectIdSchema.parse(entryProjectId),
            projectSourceKey,
            section: dragSection,
            sourceKey: threadKey,
            target: { kind: "thread", target },
            type: "home-thread-row",
            waitingOnThreadIds: entry.entryKind === "thread"
              ? entry.waitingOnThreads?.map(wait => wait.identity.threadId) ?? [] : [],
          }}
      >
        {renderRow}
      </Draggable>
    );
  };

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

  const renderFolderTooltip = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => (
    <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
      {item.entries.map((homeEntry) => {
        const project = projectsById.get(homeEntry.projectId);
        if (!project) return null;
        const qualified = qualifiedFor(homeEntry);
        const target = targetForEntry(homeEntry.entry);
        return (
          <WorkbenchThreadListItem
            compact={false}
            dimmedOverride={false}
            entry={homeEntry.entry}
            href={getThreadHref ? getThreadHref(target, homeEntry.projectId) : projectHref(qualified
              ? target.kind === "provider"
                ? createLogicalExistingThreadRoute(null, target)
                : createLogicalThreadRoute(null, qualified.logicalProjectId, qualified.location, target)
              : createHomeThreadRoute(homeEntry.projectId, target))}
            key={`tooltip:${homeEntry.threadKey}`}
            nowMs={actions.nowMs}
            onActivate={(activatedTarget) => qualified
              ? onOpenQualifiedThread?.(qualified)
              : onOpenThread(activatedTarget, homeEntry.projectId)}
            project={showProjectEyebrow ? project : undefined}
            projectId={qualified?.location.projectId ?? ProjectIdSchema.parse(homeEntry.projectId)}
            showPinPriorityIcon
            showTooltip={false}
            tabIndex={-1}
          />
        );
      })}
    </ul>
  );

  const renderFolderCreateThread = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => {
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
          onCreateThread(item.projectId, item.folder.folderId);
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

  const renderFolderEntries = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => {
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

  const renderSection = (items: WorkbenchHomeThreadDisplayItem[], section: WorkbenchThreadDisplaySection) => (
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
            <WorkbenchThreadFolder
              activeDragPayload={activeDragPayload}
              autoFocusName={actions.autoFocusFolderId === item.folder.folderId}
              attentionLabelsByThreadId={attentionLabelsByThreadId}
              canPrependThread={(payload) => canMoveWorkbenchThreadRowToSection(payload, section, item.projectId)
                && !item.folder.threadKeys.includes(payload.projectSourceKey)}
              entries={item.entries.map(({ entry }) => entry)}
              folder={item.folder}
              homeFolderKey={key}
              isDragActive={isDragActive}
              nowMs={actions.nowMs}
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
            </WorkbenchThreadFolder>
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
        if (!logicalProjects || !controls || !logicalThreads) {
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
    createProject ?? projectsById.get(selectedOwnerProjectId) ?? null;
  const canCreate = canCreateThread ?? Boolean(client.mounted && (!client.mounted.presentationClient
    || resolvedCreateProject && "matchKey" in resolvedCreateProject
    && resolvedCreateProject.locations.some(location => location.project)));
  const createLocation = resolvedCreateProject && "matchKey" in resolvedCreateProject
    ? resolvedCreateProject.locations.find(location => location.project)?.target ?? null : null;
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
          onCreateThread(createProjectId);
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
      </a> : canCreate ? null : <div className="px-2 py-2 text-[0.78rem] text-fg/muted">Waiting for project identities</div>}
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {list.pinnedItems.length ? renderSection(list.pinnedItems, "pinned") : priorityTarget("pinned")}
        {priorityTarget("main")}
        {list.mainEntries.length
          ? <ul className="m-0 flex flex-col gap-1 p-0">{list.mainEntries.map((entry) => renderEntry(entry, undefined, null, "main"))}</ul>
          : null}
        {list.snoozedItems.length ? (
          <ThreadDisclosure
            className="mt-2"
            keepMounted
            hideChevron={true}
            open={preferences.snoozedThreadsOpen}
            onToggle={(event) => setDisclosureOpen("snoozedThreadsOpen", event.currentTarget.open)}
            summary={<span className="inline-flex items-center gap-2"><SnoozedThreadIcon /><span>Snoozed threads</span></span>}
            summaryClassName="pl-2 text-[0.72rem] font-medium leading-[1.5] text-fg/muted"
          >
            {renderSection(list.snoozedItems, "snoozed")}
          </ThreadDisclosure>
        ) : priorityTarget("snoozed")}
        {historyItems.length ? (
          <ThreadDisclosure
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
          </ThreadDisclosure>
        ) : null}
      </div>
      {layoutError ? <p role="alert" className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">{layoutError}</p> : null}
    </DropTargetBoundary>
  );
}
