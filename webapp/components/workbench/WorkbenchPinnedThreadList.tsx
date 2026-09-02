/*
 * Exports:
 * - default WorkbenchPinnedThreadList: render filtered Workbench-wide pins, mixed-project folders, rows, actions, and drag order. Keywords: pinned, global, placement, folders, sidebar.
 * - Local helpers: derive pinned targets and collision-safe layout keys. Keywords: draft, provider, project, identity.
 */
"use client";

import { useMemo } from "react";

import type { WorkbenchProjectOption } from "../../lib/types";
import { WORKBENCH_THREAD_ORDER_DROP_TARGET_ID } from "../../lib/workbench/layout/workbench-drag";
import { createPinnedThreadHref, createThreadHref, isWorkbenchThreadTargetSelected } from "../../lib/workbench/navigation/workbench-route";
import type { WorkbenchSelectedProjectPinPlacement } from "../../lib/workbench/state/workbench-settings";
import {
  getProjectQualifiedThreadDisplayKey,
  getThreadDisplayFolderKey,
  projectThreadDisplayLayoutSection,
  type ThreadDisplayLayoutItem,
} from "../../lib/workbench/thread/thread-display-layout";
import {
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchThreadTarget,
} from "../../lib/workbench/thread/thread-state";
import { PinIcon } from "./workbench-icons";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";
import WorkbenchThreadStatusCountsButton from "./WorkbenchThreadStatusCountsButton";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";

const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type GlobalPinnedEntry = { entry: WorkbenchPinnedThreadSummaryEntry; project: WorkbenchProjectOption };
type PinnedThreadListActions = Pick<ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>,
  | "autoFocusFolderId"
  | "getThreadContextMenu"
  | "nowMs"
  | "onAction"
  | "onAutoFocusFolderComplete"
  | "onPinnedMove"
  | "onRenamePinnedFolder"
  | "pinnedDisplayOrder"
  | "projectThreadSummaries"
>;

function targetForEntry(entry: WorkbenchPinnedThreadSummaryEntry): WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: entry.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function displayKeyForEntry(entry: WorkbenchPinnedThreadSummaryEntry) {
  return entry.entryKind === "draft"
    ? `draft:${entry.draftId}`
    : `${entry.identity.harness}:${entry.identity.threadId}`;
}

export default function WorkbenchPinnedThreadList({
  actions,
  currentTarget,
  onOpenThread,
  projectId,
  projects,
  selectedProjectPinPlacement,
  selectedOwnerProjectId,
}: {
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
  const entries = useMemo(() => actions.projectThreadSummaries.projects.flatMap((summary) => {
    if (selectedProjectPinPlacement === "threads-section" && summary.projectId === projectId) return [];
    const project = projectsById.get(summary.projectId);
    return project ? summary.pinnedThreads.map((entry) => ({ entry, project })) : [];
  }), [actions.projectThreadSummaries.projects, projectId, projectsById, selectedProjectPinPlacement]);
  const layoutEntries = useMemo(() => entries.map(({ entry, project }) => ({
    key: getProjectQualifiedThreadDisplayKey(project.id, displayKeyForEntry(entry)),
    section: "pinned" as const,
  })), [entries]);
  const items = useMemo(() => projectThreadDisplayLayoutSection(
    entries,
    layoutEntries,
    actions.pinnedDisplayOrder,
    "pinned",
    { preserveMissing: true },
  ), [actions.pinnedDisplayOrder, entries, layoutEntries]);
  const statusCounts = useMemo(
    () => WorkbenchThreadStatusCounts.countPinnedStatuses(entries.map(({ entry }) => entry)),
    [entries],
  );
  if (!items.length) return null;

  const threadHref = (target: WorkbenchThreadTarget, ownerProjectId: string) => ownerProjectId === projectId
    ? createThreadHref(projectId, target)
    : createPinnedThreadHref(projectId, ownerProjectId, target);
  const renderEntry = ({ entry, project }: GlobalPinnedEntry) => {
    const target = targetForEntry(entry);
    const key = getProjectQualifiedThreadDisplayKey(project.id, displayKeyForEntry(entry));
    return (
      <Draggable
        dropTargetIds={[WORKBENCH_THREAD_ORDER_DROP_TARGET_ID]}
        key={key}
        label={entry.title}
        payload={{ section: "pinned", sourceKey: key, target: { kind: "thread", target }, type: "thread-row" }}
      >
        {({ draggable, onDragStart, onPointerDown }) => (
          <WorkbenchThreadListItem
            contextMenu={actions.getThreadContextMenu(entry, project.id)}
            draggable={draggable}
            entry={entry}
            href={threadHref(target, project.id)}
            isDragActive={false}
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
      enabled={(payload) => (payload.type === "thread-row" || payload.type === "thread-folder")
        && payload.section === "pinned"
        && (destinationFolderId === null || payload.type === "thread-row")}
      onDrop={(payload) => {
        if (payload.type === "thread-row" || payload.type === "thread-folder") actions.onPinnedMove(payload.sourceKey, destinationFolderId, key || null);
      }}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} />}
    </DropTarget>
  );
  const renderFolder = (item: Extract<ThreadDisplayLayoutItem<GlobalPinnedEntry>, { itemKind: "folder" }>) => (
    <li className="m-0 list-none" key={getThreadDisplayFolderKey(item.folder.folderId)}>
      <WorkbenchThreadFolder
        autoFocusName={actions.autoFocusFolderId === item.folder.folderId}
        entries={item.entries.map(({ entry }) => entry)}
        folder={item.folder}
        isDragActive={false}
        nowMs={actions.nowMs}
        onAutoFocusComplete={actions.onAutoFocusFolderComplete}
        onMoveThread={(sourceKey, destinationFolderId, beforeKey) => actions.onPinnedMove(sourceKey, destinationFolderId, beforeKey)}
        onOpenChange={(open) => setFolderOpen("pinned", item.folder.folderId, open)}
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
    <DropTargetBoundary className="pb-5">
      <WorkbenchSidebarSectionDisclosure
        actions={<WorkbenchThreadStatusCountsButton counts={statusCounts} label="pinned thread" scope="pinned" />}
        contentClassName="mt-1"
        icon={PinIcon}
        preferenceKey="pinnedThreadsOpen"
        title="Pinned threads"
      >
        <ul className="m-0 flex flex-col gap-0.5 p-0">
          {items.flatMap((item) => {
            const key = item.itemKind === "folder"
              ? getThreadDisplayFolderKey(item.folder.folderId)
              : getProjectQualifiedThreadDisplayKey(item.entry.project.id, displayKeyForEntry(item.entry.entry));
            return [renderDropMarker(key, null), item.itemKind === "folder" ? renderFolder(item) : renderEntry(item.entry)];
          })}
          {renderDropMarker("", null)}
        </ul>
      </WorkbenchSidebarSectionDisclosure>
    </DropTargetBoundary>
  );
}
