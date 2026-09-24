/*
 * Exports:
 * - default WorkbenchPinnedThreadList: render filtered Workbench-wide pins, mixed-project folders, rows, actions, and drag order.
 */
"use client";

import { useMemo, useState } from "react";

import type { WorkbenchControls, WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { projectLogicalPinnedDisplayOrder } from "../../workbench/WorkbenchProjectProjection";
import { createLogicalExistingThreadRoute, createLogicalThreadRoute, createPinnedThreadRoute, createThreadRoute, isWorkbenchThreadTargetSelected } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
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
  getThreadSidebarGroup,
} from "workbench-shared/workbench/thread/thread-state";
import {
  canMoveWorkbenchThreadRowToSection,
  isWorkbenchThreadRowDragPayload,
  WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
  WORKBENCH_THREAD_PRIORITY_DROP_TARGET_ID,
  WORKBENCH_THREAD_ROW_ACTION_DROP_TARGET_ID,
  type WorkbenchDragPayload,
  type WorkbenchThreadRowDragPayload,
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
  | "getThreadContextMenuFor"
  | "nowMs"
  | "onAction"
  | "onActionFor"
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
type GlobalPinnedEntry = { entry: GlobalPinnedListEntry; project: WorkbenchProjectOption | WorkbenchLogicalProject };

function targetForEntry (entry: GlobalPinnedListEntry): CanonicalThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: "draftId" in entry ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function displayKeyForEntry (entry: GlobalPinnedListEntry | WorkbenchThreadSidebarEntry) {
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
  actions: PinnedThreadListActions;
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
  const isShiftPressed = useNonTextInputShiftKey();
  const [layoutError, setLayoutError] = useState("");
  const { preferences, setFolderOpen } = useWorkbenchSidebarPreferences();
  const projectsById = useMemo(() => new Map(
    (logicalProjects ?? projects).map(project => [project.id, project] as const),
  ), [logicalProjects, projects]);
  const projectHref = useWorkbenchProjectNavigation();
  const currentlyPinnedEntries = useMemo(() => logicalProjects && presentation
    ? (logicalThreads ?? []).flatMap((row): GlobalPinnedEntry[] => {
      if (row.entry.entryKind === "subagent" || getThreadSidebarGroup(row.entry) !== "pinned"
        || selectedProjectPinPlacement === "threads-section"
          && row.logicalProjectId === selectedLogicalProjectId) return [];
      const project = projectsById.get(row.logicalProjectId);
      return project ? [{ entry: row.entry, project }] : [];
    })
    : actions.projectThreadSummaries.projects.flatMap((summary) => {
    if (selectedProjectPinPlacement === "threads-section" && summary.projectId === projectId) return [];
    const project = projectsById.get(summary.projectId);
    return project ? summary.pinnedThreads
      .map((entry) => ({ entry, project })) : [];
  }), [actions.projectThreadSummaries.projects, projectId, projectsById, selectedProjectPinPlacement,
    selectedLogicalProjectId, logicalProjects, logicalThreads, presentation]);
  const currentEntries = useMemo(() => logicalProjects && presentation ? currentlyPinnedEntries
    : actions.projectThreadSidebars.projects.flatMap((sidebar) => {
    const project = projectsById.get(sidebar.projectId);
    if (!project) return [];
    return sidebar.entries.flatMap((entry): GlobalPinnedEntry[] => entry.entryKind === "subagent" ? [] : [{ entry, project }]);
  }), [actions.projectThreadSidebars.projects, projectsById, logicalProjects, presentation, currentlyPinnedEntries]);
  const placement = useContextMenuPlacementSnapshot("thread-list", {
    displayOrder: logicalProjects && presentation
      ? projectLogicalPinnedDisplayOrder(logicalThreads ?? [], presentation)
      : actions.pinnedDisplayOrder,
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
  const statusCounts = useMemo(() => WorkbenchThreadStatusCounts.countPinnedStatuses(
    logicalProjects
      ? Object.entries(logicalSummaries ?? {}).flatMap(([logicalId, summary]) =>
        selectedProjectPinPlacement === "threads-section" && logicalId === selectedLogicalProjectId
          ? [] : summary.pinnedThreads.map(item => item.entry))
      : currentlyPinnedEntries.map(({ entry }) => entry as WorkbenchPinnedThreadSummaryEntry),
  ), [currentlyPinnedEntries, logicalProjects, logicalSummaries, selectedProjectPinPlacement, selectedLogicalProjectId]);
  const priorityDropVisible = Boolean(
    isWorkbenchThreadRowDragPayload(activeDragPayload)
    && activeDragPayload.section !== "pinned"
    && activeDragPayload.section !== "settled",
  );
  if (!items.length && !priorityDropVisible) return null;

  const sourceFor = (ownerProjectId: string, target: WorkbenchThreadTarget) => {
    if (logicalProjects) return logicalThreads?.find(row => row.logicalProjectId === ownerProjectId
      && (target.kind === "draft" ? row.entry.entryKind === "draft"
        && row.entry.draft.draftId === target.draftId
        : target.kind === "provider" && row.entry.entryKind !== "draft"
          && row.entry.identity.threadId === target.threadId));
    const daemonId = selectedLocation?.daemonId ?? attachedDaemonId;
    return logicalThreads?.find(row => row.location.daemonId === daemonId
      && row.location.projectId === ownerProjectId
      && (target.kind === "draft" ? row.entry.entryKind === "draft" && row.entry.draft.draftId === target.draftId
        : target.kind === "provider" && row.entry.entryKind !== "draft"
          && row.entry.identity.threadId === target.threadId
          && (!target.harness || row.entry.identity.harness === target.harness)));
  };
  const threadHref = (target: WorkbenchThreadTarget, ownerProjectId: string) => {
    const source = sourceFor(ownerProjectId, target);
    return source
      ? projectHref(target.kind === "provider"
        ? createLogicalExistingThreadRoute(selectedLogicalProjectId ?? null, target)
        : createLogicalThreadRoute(selectedLogicalProjectId ?? null,
          source.logicalProjectId, source.location, target))
      : logicalProjects ? undefined
      : ownerProjectId === projectId
        ? projectHref(createThreadRoute(projectId, target))
        : projectHref(createPinnedThreadRoute(projectId, ownerProjectId, target));
  };
  const rowForPayload = (payload: WorkbenchThreadRowDragPayload) => logicalThreads?.find(row =>
    displayKeyForEntry(row.entry) === payload.projectSourceKey
    && (row.logicalProjectId === payload.ownerProjectId
      || row.location.projectId === payload.ownerProjectId));
  const keyForPayload = (payload: WorkbenchThreadRowDragPayload) => {
    if (!logicalProjects) return getProjectQualifiedThreadDisplayKey(
      payload.ownerProjectId, payload.projectSourceKey,
    );
    const row = rowForPayload(payload);
    return row ? getProjectQualifiedThreadDisplayKey(
      row.logicalProjectId, displayKeyForEntry(row.entry),
    ) : null;
  };
  const updatePinned = async (intent: Parameters<WorkbenchControls["updatePresentationPinnedLayout"]>[1]) => {
    if (!controls || !logicalThreads) return false;
    try {
      await controls.updatePresentationPinnedLayout(logicalThreads, intent);
      setLayoutError("");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Pinned layout could not be saved.";
      setLayoutError(message);
      console.error("Pinned layout update failed", message);
      return false;
    }
  };
  const renderEntry = ({ entry, project }: GlobalPinnedEntry) => {
    const target = targetForEntry(entry);
    const qualified = sourceFor(project.id, target);
    const logicalProject = qualified && logicalProjects?.find(item => item.id === qualified.logicalProjectId);
    const sourceProjectId = qualified?.location.projectId ?? ProjectIdSchema.parse(project.id);
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
          ? (payload) => {
            if (!logicalProjects) {
              actions.onPinnedFolderDrop(payload, sourceProjectId, projectSourceKey, folder?.folderId ?? null);
              return;
            }
            const sourceKey = keyForPayload(payload);
            if (sourceKey) void updatePinned({
              kind: "drop", sourceKey, targetKey: key, destinationFolderId: folder?.folderId ?? null,
            });
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
            contextMenu={qualified
              ? actions.getThreadContextMenuFor(entry, "pinned")
              : logicalProjects ? null : actions.getThreadContextMenu(entry, sourceProjectId, "pinned")}
            draggable={draggable}
            dragTargets={dragTargets}
            entry={entry}
            href={threadHref(target, project.id)}
            isDragActive={Boolean(activeDragPayload)}
            isShiftPressed={isShiftPressed}
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
            selected={project.id === selectedOwnerProjectId && isWorkbenchThreadTargetSelected(target, currentTarget)}
            showActions={logicalProjects ? true : project.id === projectId || entry.entryKind !== "draft"}
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
          const sourceKey = keyForPayload(payload);
          if (!sourceKey) return;
          if (logicalProjects) void updatePinned({
            kind: "move", sourceKey, destinationFolderId, beforeKey: key || null,
          });
          else actions.onPinnedMove(sourceKey, destinationFolderId, key || null);
        } else if (payload.type === "thread-folder") {
          if (logicalProjects) void updatePinned({
            kind: "move", sourceKey: payload.sourceKey, destinationFolderId, beforeKey: key || null,
          });
          else actions.onPinnedMove(payload.sourceKey, destinationFolderId, key || null);
        }
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
          const sourceKey = keyForPayload(payload);
          return Boolean(sourceKey && canMoveWorkbenchThreadRowToSection(payload, "pinned")
            && !item.folder.threadKeys.includes(sourceKey));
        }}
        entries={item.entries.map(({ entry }) => entry)}
        folder={item.folder}
        isDragActive={Boolean(activeDragPayload)}
        nowMs={actions.nowMs}
        onAutoFocusComplete={actions.onAutoFocusFolderComplete}
        onOpenChange={(open) => setFolderOpen("pinned", item.folder.folderId, open)}
        onPrependThread={(payload) => {
          const sourceKey = keyForPayload(payload);
          if (!sourceKey) return;
          if (logicalProjects) void updatePinned({
            kind: "move", sourceKey, destinationFolderId: item.folder.folderId,
            beforeKey: item.folder.threadKeys[0] ?? null,
          });
          else actions.onPinnedMove(sourceKey, item.folder.folderId, item.folder.threadKeys[0] ?? null);
        }}
        onRename={async (title) => {
          if (!logicalProjects) return await actions.onRenamePinnedFolder(item.folder.folderId, title);
          if (!await updatePinned({ kind: "rename", folderId: item.folder.folderId, title })) {
            throw new Error("Pinned folder rename could not be saved.");
          }
          return title.trim();
        }}
        open={preferences.pinnedFolderIds.includes(item.folder.folderId)}
        tooltip={(
          <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
            {item.entries.map(({ entry, project }) => {
              const target = targetForEntry(entry);
              const qualified = sourceFor(project.id, target);
              return <WorkbenchThreadListItem
                compact={false}
                dimmedOverride={false}
                entry={entry}
                href={threadHref(target, project.id)}
                key={`tooltip:${getProjectQualifiedThreadDisplayKey(project.id, displayKeyForEntry(entry))}`}
                nowMs={actions.nowMs}
                onActivate={(activatedTarget) => qualified
                  ? onOpenQualifiedThread?.(qualified)
                  : onOpenThread(activatedTarget, project.id)}
                project={project}
                projectId={qualified?.location.projectId ?? ProjectIdSchema.parse(project.id)}
                showTooltip={false}
                tabIndex={-1}
              />;
            })}
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
            onDrop={(payload) => {
              if (!logicalProjects) {
                actions.onSetPriority(payload, "pinned");
                return;
              }
              const sourceKey = keyForPayload(payload);
              if (sourceKey) void updatePinned({
                kind: "move", sourceKey, destinationFolderId: null, beforeKey: null,
              });
            }}
            priority="pinned"
          />
        )}
      </WorkbenchSidebarSectionDisclosure>
      {layoutError ? <p role="alert" className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">{layoutError}</p> : null}
    </DropTargetBoundary>
  );
}
