/*
 * Exports:
 * - default WorkbenchHomeThreadList: render one projectless thread list with global priority order, project-owned folders, owner context, and guarded drag actions.
 */
"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import {
  projectLogicalHomeDisplayOrder, projectLogicalThreadDisplayOrder,
} from "../../workbench/WorkbenchProjectProjection";
import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadDragSection,
  type WorkbenchThreadRowDragPayload,
} from "../../workbench/layout/workbench-drag";
import { createHomeThreadRoute, createLogicalExistingThreadRoute, createLogicalThreadRoute, isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import {
  getWorkbenchHomeFolderKey,
  getWorkbenchHomeThreadKey,
  moveWorkbenchHomeThreadDisplayItem,
  projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayItem,
  type WorkbenchHomeThreadEntry,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import {
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  findWorkbenchThreadFolder,
  type WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { ProjectIdSchema, type FolderId, type ProjectThreadDisplayKey } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadPriority, WorkbenchThreadSidebarEntry, WorkbenchThreadRouteTarget as WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
import {
  mergeContextMenuPlacementEntries,
  useContextMenuPlacementSnapshot,
} from "./context-menu-placement";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { SparkleIcon } from "./workbench-icons";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadDragTargets from "./WorkbenchThreadDragTargets";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadPriorityDropZone from "./WorkbenchThreadPriorityDropZone";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type HomeThreadActions = ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>;

function targetForEntry(entry: WorkbenchThreadSidebarEntry): import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function itemThreadCount(item: WorkbenchHomeThreadDisplayItem) {
  return item.threadKeys.length;
}

function homeItemKey(item: WorkbenchHomeThreadDisplayItem) {
  return item.itemKind === "folder"
    ? getWorkbenchHomeFolderKey(item.projectId, item.folder.folderId)
    : item.entry.threadKey;
}

function homeListEntries(list: ReturnType<typeof projectWorkbenchHomeThreadList>) {
  return [
    ...list.archivedEntries,
    ...list.mainEntries,
    ...list.pinnedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.settledItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
    ...list.snoozedItems.flatMap(item => item.itemKind === "folder" ? item.entries : [item.entry]),
  ];
}

function mergeHomeDisplayItems(
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

export default function WorkbenchHomeThreadList({
  actions,
  activeDragPayload,
  attentionLabelsByThreadId,
  createProject,
  currentTarget,
  onCreateThread,
  onOpenThread,
  projects,
  renderThreadTooltipDetails,
  selectedOwnerProjectId,
  logicalProjects,
  logicalThreads,
  presentation,
  controls,
  attachedDaemonId,
  onOpenQualifiedThread,
}: {
  actions: HomeThreadActions;
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  createProject: WorkbenchProjectOption | WorkbenchLogicalProject;
  currentTarget: WorkbenchThreadTarget | null;
  onCreateThread: (ownerProjectId: string, folderId?: FolderId) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projects: readonly WorkbenchProjectOption[];
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
  logicalProjects?: readonly WorkbenchLogicalProject[];
  logicalThreads?: readonly WorkbenchLogicalThreadRow[];
  presentation?: PresentationSnapshot | null;
  controls?: WorkbenchControls | null;
  attachedDaemonId?: string | null;
  onOpenQualifiedThread?: (row: WorkbenchLogicalThreadRow) => void;
}) {
  const isShiftPressed = useNonTextInputShiftKey();
  const [layoutError, setLayoutError] = useState("");
  const homeDisplayOrderSupported = Boolean(logicalProjects && presentation && controls)
    || actions.homeDisplayOrderSupported;
  const projectHref = useWorkbenchProjectNavigation();
  const {
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setSettledThreadItemLimit,
  } = useWorkbenchSidebarPreferences();
  const projectsById = useMemo(() => new Map<string, WorkbenchProjectOption | WorkbenchLogicalProject>(
    (logicalProjects ?? projects).map(project => [project.id, project] as const),
  ), [logicalProjects, projects]);
  const currentList = useMemo(() => projectWorkbenchHomeThreadList(
    logicalProjects && presentation ? {
      projects: logicalProjects.map(project => ({
        projectId: project.id,
        entries: (logicalThreads ?? []).filter(row => row.logicalProjectId === project.id).map(row => row.entry),
        displayOrder: projectLogicalThreadDisplayOrder(project.id, logicalThreads ?? [], presentation),
      })),
    } : actions.projectThreadSidebars,
    logicalProjects && presentation
      ? projectLogicalHomeDisplayOrder(logicalThreads ?? [], presentation)
      : actions.homeDisplayOrder,
  ), [actions.homeDisplayOrder, actions.projectThreadSidebars, logicalProjects, logicalThreads, presentation]);
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
  const homeKeyForPayload = (payload: WorkbenchThreadRowDragPayload) => {
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
    if (!logicalProjects || !presentation || !controls || !logicalThreads) {
      actions.onHomeMove(sourceKey, section, destinationFolderKey, beforeKey);
      return;
    }
    try {
      const allItems = [...currentList.pinnedItems, ...currentList.snoozedItems, ...currentList.settledItems];
      const sourceItem = allItems.find(item => homeItemKey(item) === sourceKey);
      const sourceKeys = sourceItem?.itemKind === "folder" ? sourceItem.threadKeys : [sourceKey];
      const sourceRow = logicalThreads.find(row =>
        getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) === sourceKey);
      const destination = destinationFolderKey
        ? allItems.find(item => item.itemKind === "folder"
          && homeItemKey(item) === destinationFolderKey) : null;
      if (destinationFolderKey && (!destination || destination.itemKind !== "folder")) {
        throw new Error("That folder is unavailable.");
      }
      if (destination?.itemKind === "folder"
        && (!sourceRow || sourceRow.logicalProjectId !== destination.projectId)) {
        throw new Error("That folder belongs to another project.");
      }
      const sourceSection = sourceRow && getWorkbenchThreadDisplaySection(sourceRow.entry);
      if (sourceRow && sourceSection !== section) {
        if (section === "settled" || sourceRow.entry.entryKind === "subagent"
          || sourceRow.entry.metadata.archived) {
          throw new Error("This thread cannot move to that section.");
        }
        const priority = section === "pinned" ? "pinned" : "snoozed";
        if (sourceRow.entry.entryKind === "draft") {
          await controls.setPresentationDraftPriority(sourceRow.entry.draft.draftId, {
            pinned: priority === "pinned", snoozed: priority === "snoozed",
          });
        } else {
          const accepted = await controls.threadAction(sourceRow.entry.identity.threadId,
            { kind: "priority", priority });
          if (!accepted) throw new Error("The source daemon rejected this priority change.");
        }
      }
      const rows: WorkbenchLogicalThreadRow[] = logicalThreads.map(row => row !== sourceRow || sourceSection === section
        || row.entry.entryKind === "subagent" ? row : {
        ...row, entry: {
          ...row.entry, metadata: {
            archived: false as const, pinned: section === "pinned", snoozed: section === "snoozed",
          },
        },
      } satisfies WorkbenchLogicalThreadRow);
      const layoutEntries = rows.flatMap(row => {
        const itemSection = getWorkbenchThreadDisplaySection(row.entry);
        return itemSection ? [{
          key: getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry), section: itemSection,
        }] : [];
      });
      const nextHome = moveWorkbenchHomeThreadDisplayItem(
        layoutEntries, currentList.displayOrder, section, sourceKeys, beforeKey,
      );
      if (!nextHome) throw new Error("The home position is no longer available.");
      if (sourceRow) {
        const projectOrder = projectLogicalThreadDisplayOrder(
          sourceRow.logicalProjectId, logicalThreads, presentation,
        );
        const localKey = getWorkbenchThreadDisplayKey(sourceRow.entry);
        const sourceFolder = findWorkbenchThreadFolder(projectOrder, localKey);
        const destinationFolder = destination?.itemKind === "folder" ? destination.folder : null;
        if (destinationFolder || sourceFolder) {
          const beforeRow = beforeKey ? rows.find(row =>
            getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry) === beforeKey) : null;
          await controls.updatePresentationProjectLayout(
            sourceRow.logicalProjectId, rows, {
              kind: "move", section, sourceKey: localKey,
              destinationFolderId: destinationFolder?.folderId ?? null,
              beforeKey: beforeRow?.logicalProjectId === sourceRow.logicalProjectId
                ? getWorkbenchThreadDisplayKey(beforeRow.entry) : null,
            }, nextHome,
          );
        } else {
          await controls.savePresentationHomeLayout(rows, nextHome);
        }
      } else {
        await controls.savePresentationHomeLayout(rows, nextHome);
      }
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
  const currentEntries = homeListEntries(currentList);
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
    pinnedItems: mergeHomeDisplayItems(placementList.pinnedItems, currentEntries),
    settledItems: mergeHomeDisplayItems(placementList.settledItems, currentEntries),
    snoozedItems: mergeHomeDisplayItems(placementList.snoozedItems, currentEntries),
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

  const renderEntry = (
    homeEntry: WorkbenchHomeThreadEntry,
    reorderSection?: WorkbenchThreadDisplaySection,
    placementFolder: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>["folder"] | null = null,
    placementSection?: WorkbenchThreadDragSection | "archived",
  ) => {
    const { entry, projectId, threadKey } = homeEntry;
    const project = projectsById.get(projectId);
    if (!project) return null;
    const target = targetForEntry(entry);
    const qualified = qualifiedFor(homeEntry);
    const logicalProject = qualified && logicalProjects?.find(item => item.id === qualified.logicalProjectId);
    const sourceProjectId = qualified?.location.projectId ?? ProjectIdSchema.parse(projectId);
    const projectSourceKey = getWorkbenchThreadDisplayKey(entry);
    const frozenSection = placementSection ?? reorderSection ?? (entry.metadata.pinned ? "pinned" : "main");
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
      && activeDragPayload.ownerProjectId === projectId
      && (reorderSection !== "settled" || activeDragPayload.section === "settled"),
    );
    const dragTargets = archived ? null : (
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
        onSnoozeUntilDrop={targetIdentity && !targetReady
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
        targetProjectId={projectId}
        targetTitle={entry.title}
      />
    );
    const renderRow = ({ draggable = false, onDragStart, onPointerDown }: {
      draggable?: boolean;
      onDragStart?: import("react").DragEventHandler<HTMLElement>;
      onPointerDown?: import("react").PointerEventHandler<HTMLElement>;
    } = {}) => (
      <WorkbenchThreadListItem
        attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
        compact={false}
        contextMenu={qualified
          ? actions.getThreadContextMenuFor(entry, "project")
          : logicalProjects ? null : actions.getThreadContextMenu(entry, sourceProjectId, "project")}
        draggable={draggable}
        dragTargets={dragTargets}
        entry={entry}
        href={projectHref(qualified
          ? target.kind === "provider"
            ? createLogicalExistingThreadRoute(null, target)
            : createLogicalThreadRoute(null, qualified.logicalProjectId, qualified.location, target)
          : createHomeThreadRoute(projectId, target))}
        isDragActive={isDragActive}
        isShiftPressed={isShiftPressed}
        key={threadKey}
        nowMs={actions.nowMs}
        onAction={(action) => qualified
          ? actions.onActionFor(entry, action)
          : actions.onAction(entry, action, sourceProjectId)}
        onActivate={(activatedTarget) => qualified
          ? onOpenQualifiedThread?.(qualified) : onOpenThread(activatedTarget, sourceProjectId)}
        onDragStart={onDragStart}
        onPointerDown={onPointerDown}
        project={logicalProject ?? project}
        projectId={sourceProjectId}
        ownerLabel={qualified ? `${qualified.hostname} · ${qualified.rootPath}` : undefined}
        selected={projectId === selectedOwnerProjectId && isWorkbenchThreadTargetSelected(target, currentTarget)}
        showActions
        showPinPriorityIcon
        tooltipDetails={renderThreadTooltipDetails?.(entry)}
      />
    );
    return (
      <Draggable
        disabled={archived}
        dropTargetIds={[
          ...(homeDisplayOrderSupported ? [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID] : []),
          WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
          WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
        ]}
        key={threadKey}
        label={entry.title}
        payload={{
          ownerProjectId: projectId,
          projectSourceKey,
          section: dragSection,
          sourceKey: threadKey,
          target: { kind: "thread", target },
          type: "home-thread-row",
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
          const key = homeKeyForPayload(payload);
          if (key) void moveHome(key, section, destinationFolderKey, beforeKey);
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
            href={projectHref(qualified
              ? target.kind === "provider"
                ? createLogicalExistingThreadRoute(null, target)
                : createLogicalThreadRoute(null, qualified.logicalProjectId, qualified.location, target)
              : createHomeThreadRoute(homeEntry.projectId, target))}
            key={`tooltip:${homeEntry.threadKey}`}
            nowMs={actions.nowMs}
            onActivate={(activatedTarget) => qualified
              ? onOpenQualifiedThread?.(qualified)
              : onOpenThread(activatedTarget, homeEntry.projectId)}
            project={project}
            projectId={qualified?.location.projectId ?? ProjectIdSchema.parse(homeEntry.projectId)}
            showPinPriorityIcon
            showTooltip={false}
            tabIndex={-1}
          />
        );
      })}
    </ul>
  );

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

  const renderFolderCreateThread = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => {
    const target = { folderId: item.folder.folderId, kind: "new" as const };
    const logicalProject = logicalProjects?.find(project => project.id === item.projectId);
    const location = logicalProject?.locations.find(candidate => candidate.project)?.target
      ?? logicalProject?.locations[0]?.target ?? null;
    const selected = selectedOwnerProjectId === item.projectId && isWorkbenchThreadTargetSelected(target, currentTarget);
    return (
      <a
        href={projectHref(logicalProject
          ? createLogicalThreadRoute(null, logicalProject.id, location, target)
          : createHomeThreadRoute(item.projectId, target))}
        title="Create new thread"
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
          <span className={workbenchThreadListLabelClassName}>Create new thread</span>
        </span>
      </a>
    );
  };

  const renderSection = (items: WorkbenchHomeThreadDisplayItem[], section: WorkbenchThreadDisplaySection) => (
    <ul className="m-0 flex flex-col gap-0.5 p-0">
      {items.flatMap((item) => {
        const key = homeItemKey(item);
        const beforeKey = item.threadKeys[0] ?? null;
        if (item.itemKind === "thread") {
          return [
            renderDropMarker(key, beforeKey, section, null, null),
            renderEntry(item.entry, section),
          ];
        }
        const project = projectsById.get(item.projectId);
        if (!project) return [];
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
                const sourceKey = homeKeyForPayload(payload);
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
              project={project}
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

  const createLocation = "matchKey" in createProject
    ? createProject.locations.find(location => location.project)?.target ?? null : null;
  const createProjectId = createLocation?.projectId ?? createProject.id;
  const blankThreadSelected = selectedOwnerProjectId === createProject.id
    && isWorkbenchThreadTargetSelected({ kind: "new" }, currentTarget);
  return (
    <DropTargetBoundary className="space-y-1">
      <a
        href={projectHref("matchKey" in createProject
          ? createLogicalThreadRoute(null, createProject.id, createLocation, { kind: "new" })
          : createHomeThreadRoute(createProject.id, { kind: "new" }))}
        title="Create new thread"
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
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="shrink-0" size={16} />
          <span className={workbenchThreadListLabelClassName}>Create new thread</span>
        </span>
      </a>
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {list.pinnedItems.length ? renderSection(list.pinnedItems, "pinned") : priorityTarget("pinned")}
        {priorityTarget("main")}
        {list.mainEntries.length
          ? <ul className="m-0 flex flex-col gap-1 p-0">{list.mainEntries.map((entry) => renderEntry(entry, undefined, null, "main"))}</ul>
          : null}
        {list.snoozedItems.length ? renderSection(list.snoozedItems, "snoozed") : priorityTarget("snoozed")}
        {historyItems.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={preferences.settledThreadsOpen}
            onToggle={(event) => setDisclosureOpen("settledThreadsOpen", event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-fg/muted"
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
