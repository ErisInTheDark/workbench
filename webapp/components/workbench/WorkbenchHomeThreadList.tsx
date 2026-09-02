/*
 * Exports:
 * - default WorkbenchHomeThreadList: render one projectless thread list with global priority order, project-owned folders, owner context, and guarded drag actions. Keywords: home, threads, folders, project, drag.
 * - Local render helpers: render home-qualified rows, folder blocks, drop markers, creation links, and settled pagination. Keywords: sidebar, order, disclosure, navigation.
 */
"use client";

import { useMemo, type ReactNode } from "react";

import type { WorkbenchProjectOption } from "../../lib/types";
import { WORKBENCH_THREAD_ORDER_DROP_TARGET_ID, type WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import { createHomeThreadHref, isWorkbenchThreadTargetSelected } from "../../lib/workbench/navigation/workbench-route";
import {
  getWorkbenchHomeFolderKey,
  projectWorkbenchHomeThreadList,
  type WorkbenchHomeThreadDisplayItem,
  type WorkbenchHomeThreadEntry,
} from "../../lib/workbench/thread/home-thread-display-order";
import type { WorkbenchThreadDisplaySection } from "../../lib/workbench/thread/thread-display-order";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import { workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import { SparkleIcon } from "./workbench-icons";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import Draggable from "./drag/Draggable";
import DropTarget from "./drag/DropTarget";
import DropTargetBoundary from "./drag/DropTargetBoundary";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";
import WorkbenchThreadFolder from "./WorkbenchThreadFolder";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchThreadSidebarActionsProvider from "./WorkbenchThreadSidebarActions";
import { useNonTextInputShiftKey } from "./use-non-text-input-shift-key";

const SETTLED_THREAD_PAGE_SIZE = 50;
const THREAD_ORDER_DROP_RANGE = { x: 24, y: 100_000 } as const;
type HomeThreadActions = ReturnType<typeof WorkbenchThreadSidebarActionsProvider.useActions>;

function targetForEntry(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadTarget {
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
}: {
  actions: HomeThreadActions;
  activeDragPayload: WorkbenchDragPayload | null;
  attentionLabelsByThreadId: Record<string, string | undefined>;
  createProject: WorkbenchProjectOption;
  currentTarget: WorkbenchThreadTarget | null;
  onCreateThread: (ownerProjectId: string, folderId?: string) => void;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projects: readonly WorkbenchProjectOption[];
  renderThreadTooltipDetails?: (entry: WorkbenchThreadSidebarEntry) => ReactNode;
  selectedOwnerProjectId: string;
}) {
  const isShiftPressed = useNonTextInputShiftKey();
  const {
    preferences,
    setDisclosureOpen,
    setFolderOpen,
    setSettledThreadItemLimit,
  } = useWorkbenchSidebarPreferences();
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const list = useMemo(() => projectWorkbenchHomeThreadList(
    actions.projectThreadSidebars,
    actions.homeDisplayOrder,
  ), [actions.homeDisplayOrder, actions.projectThreadSidebars]);
  const settledLimit = preferences.settledThreadItemLimit;
  let settledThreadCount = 0;
  const displayedSettledItems = list.settledItems.filter((item, index) => {
    const count = itemThreadCount(item);
    if (settledThreadCount >= settledLimit && index > 0) return false;
    settledThreadCount += count;
    return true;
  });
  const displayedSettledThreadCount = displayedSettledItems.reduce((count, item) => count + itemThreadCount(item), 0);
  const remainingSettledThreadCount = list.settledItems.reduce((count, item) => count + itemThreadCount(item), 0) - displayedSettledThreadCount;
  const nextSettledThreadCount = Math.min(SETTLED_THREAD_PAGE_SIZE, remainingSettledThreadCount);
  const isDragActive = Boolean(activeDragPayload);

  const renderEntry = (
    homeEntry: WorkbenchHomeThreadEntry,
    reorderSection?: WorkbenchThreadDisplaySection,
  ) => {
    const { entry, projectId, threadKey } = homeEntry;
    const project = projectsById.get(projectId);
    if (!project) return null;
    const target = targetForEntry(entry);
    const row = (
      <WorkbenchThreadListItem
        attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
        compact={false}
        contextMenu={actions.getThreadContextMenu(entry, projectId)}
        entry={entry}
        href={createHomeThreadHref(projectId, target)}
        isDragActive={isDragActive}
        isShiftPressed={isShiftPressed}
        key={threadKey}
        nowMs={actions.nowMs}
        onAction={(action) => actions.onAction(entry, action, projectId)}
        onActivate={(activatedTarget) => onOpenThread(activatedTarget, projectId)}
        project={project}
        projectId={projectId}
        selected={projectId === selectedOwnerProjectId && isWorkbenchThreadTargetSelected(target, currentTarget)}
        showActions
        showPinPriorityIcon
        tooltipDetails={renderThreadTooltipDetails?.(entry)}
      />
    );
    if (!reorderSection || !actions.homeDisplayOrderSupported) return row;
    return (
      <Draggable
        dropTargetIds={[WORKBENCH_THREAD_ORDER_DROP_TARGET_ID]}
        key={threadKey}
        label={entry.title}
        payload={{
          ownerProjectId: projectId,
          section: reorderSection,
          sourceKey: threadKey,
          target: { kind: "thread", target },
          type: "home-thread-row",
        }}
      >
        {({ draggable, onDragStart, onPointerDown }) => (
          <WorkbenchThreadListItem
            attentionLabel={entry.entryKind === "draft" ? "" : attentionLabelsByThreadId[entry.identity.threadId]}
            compact={false}
            contextMenu={actions.getThreadContextMenu(entry, projectId)}
            draggable={draggable}
            entry={entry}
            href={createHomeThreadHref(projectId, target)}
            isDragActive={isDragActive}
            isShiftPressed={isShiftPressed}
            nowMs={actions.nowMs}
            onAction={(action) => actions.onAction(entry, action, projectId)}
            onActivate={(activatedTarget) => onOpenThread(activatedTarget, projectId)}
            onDragStart={onDragStart}
            onPointerDown={onPointerDown}
            project={project}
            projectId={projectId}
            selected={projectId === selectedOwnerProjectId && isWorkbenchThreadTargetSelected(target, currentTarget)}
            showActions
            showPinPriorityIcon
            tooltipDetails={renderThreadTooltipDetails?.(entry)}
          />
        )}
      </Draggable>
    );
  };

  const renderDropMarker = (
    key: string,
    beforeKey: string | null,
    section: WorkbenchThreadDisplaySection,
    destinationFolderKey: string | null,
    destinationProjectId: string | null,
  ) => actions.homeDisplayOrderSupported ? (
    <DropTarget
      as="li"
      className="m-0 list-none"
      dropTargetId={WORKBENCH_THREAD_ORDER_DROP_TARGET_ID}
      key={`before:${destinationFolderKey ?? "root"}:${key}`}
      range={THREAD_ORDER_DROP_RANGE}
      enabled={(payload) => (payload.type === "home-thread-row" || payload.type === "home-thread-folder")
        && payload.section === section
        && (destinationFolderKey === null
          || (payload.type === "home-thread-row" && payload.ownerProjectId === destinationProjectId))}
      onDrop={(payload) => {
        if (payload.type === "home-thread-row" || payload.type === "home-thread-folder") {
          actions.onHomeMove(payload.sourceKey, section, destinationFolderKey, beforeKey);
        }
      }}
    >
      {({ selected }) => <div aria-hidden="true" className={`pointer-events-none relative z-30 h-px rounded-full transition-colors${selected ? " bg-accent" : " bg-transparent"}`} />}
    </DropTarget>
  ) : null;

  const renderFolderTooltip = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => (
    <ul className="m-0 flex w-[min(28rem,calc(100vw-2rem))] max-w-full list-none flex-col gap-0.5 p-0">
      {item.entries.map((homeEntry) => {
        const project = projectsById.get(homeEntry.projectId);
        if (!project) return null;
        const target = targetForEntry(homeEntry.entry);
        return (
          <WorkbenchThreadListItem
            compact={false}
            dimmedOverride={false}
            entry={homeEntry.entry}
            href={createHomeThreadHref(homeEntry.projectId, target)}
            key={`tooltip:${homeEntry.threadKey}`}
            nowMs={actions.nowMs}
            onActivate={(activatedTarget) => onOpenThread(activatedTarget, homeEntry.projectId)}
            project={project}
            projectId={homeEntry.projectId}
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
            renderEntry(entry, item.folder.section),
          ])}
          {renderDropMarker("", null, item.folder.section, folderKey, item.projectId)}
        </ul>
      </DropTargetBoundary>
    );
  };

  const renderFolderCreateThread = (item: Extract<WorkbenchHomeThreadDisplayItem, { itemKind: "folder" }>) => {
    const target = { folderId: item.folder.folderId, kind: "new" as const };
    return (
      <a
        href={createHomeThreadHref(item.projectId, target)}
        title="Create new thread"
        className={`${workbenchThreadListButtonClassName} text-muted`}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(item.projectId, item.folder.folderId);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="size-4 shrink-0" />
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
              entries={item.entries.map(({ entry }) => entry)}
              folder={item.folder}
              homeFolderKey={key}
              isDragActive={isDragActive}
              nowMs={actions.nowMs}
              onAutoFocusComplete={actions.onAutoFocusFolderComplete}
              onMoveThread={(sourceKey, destinationFolderKey, beforeThreadKey) => actions.onHomeMove(sourceKey, section, destinationFolderKey, beforeThreadKey)}
              onOpenChange={(open) => setFolderOpen("threads", key, open)}
              onRename={(title) => actions.onRenameFolder(item.folder.folderId, title, item.projectId)}
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

  return (
    <DropTargetBoundary className="space-y-1">
      <a
        href={createHomeThreadHref(createProject.id, { kind: "new" })}
        title="Create new thread"
        className={`${workbenchThreadListButtonClassName} mt-1 text-muted`}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          onCreateThread(createProject.id);
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="size-4 shrink-0" />
          <span className={workbenchThreadListLabelClassName}>Create new thread</span>
        </span>
      </a>
      <div role="tablist" aria-label="Threads" className="min-w-0">
        {list.pinnedItems.length ? renderSection(list.pinnedItems, "pinned") : null}
        {list.mainEntries.length ? <ul className="m-0 flex flex-col gap-1 p-0">{list.mainEntries.map((entry) => renderEntry(entry))}</ul> : null}
        {list.snoozedItems.length ? renderSection(list.snoozedItems, "snoozed") : null}
        {list.settledItems.length ? (
          <ThreadDisclosure
            className="mt-4"
            contentClassName="mt-1"
            open={preferences.settledThreadsOpen}
            onToggle={(event) => setDisclosureOpen("settledThreadsOpen", event.currentTarget.open)}
            summary="Settled threads"
            summaryClassName="text-[0.72rem] font-medium leading-[1.5] text-muted"
          >
            {renderSection(displayedSettledItems, "settled")}
            {remainingSettledThreadCount > 0 ? (
              <button
                type="button"
                aria-label={`Load ${nextSettledThreadCount} more settled threads`}
                className={`${workbenchThreadListButtonClassName} mt-1 justify-center text-center text-[0.72rem] font-medium text-muted`}
                onClick={() => setSettledThreadItemLimit(preferences.settledThreadItemLimit + SETTLED_THREAD_PAGE_SIZE)}
              >
                Load {nextSettledThreadCount} more
              </button>
            ) : null}
          </ThreadDisclosure>
        ) : null}
      </div>
    </DropTargetBoundary>
  );
}
