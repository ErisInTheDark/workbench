/*
 * Exports:
 * - default WorkbenchThreadSidebarActionsProvider: own shared thread-sidebar subscriptions, mutations, menus, folder focus, relative time, and expose the colocated context hook.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ThreadSummary, WorkbenchControls, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchThreadRowDragPayload } from "../../workbench/layout/workbench-drag";
import { writeTextToClipboard } from "../../workbench/dom/clipboard";
import { findWorkbenchThreadFolder, getWorkbenchThreadDisplayKey, type WorkbenchThreadDisplayOrder, type WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayDraftKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { FolderIdSchema, type ProjectId, type ThreadDisplayKey, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import {
  getThreadSidebarGroup,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchThreadStatusProviderOwned,
  isWorkbenchSidebarThreadCompletionAvailable,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchProjectThreadSidebars,
  type WorkbenchProjectThreadSummaries,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadPriority,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import { getNeedsAttentionThreadStatusTone } from "./workbench-thread-status-colors";
import {
  useWorkbenchHomeThreadDisplayOrder,
  useWorkbenchHomeThreadDisplayOrderSupported,
  useWorkbenchPinnedThreadLayout,
  useWorkbenchProjectThreadSidebar,
  useWorkbenchProjectThreadSidebars,
  useWorkbenchProjectThreadSummaries,
} from "./use-workbench-client";
import {
  ArchiveIcon,
  CompletedThreadIcon,
  CopyIcon,
  FolderInputIcon,
  NeedsAttentionThreadIcon,
  OpenThreadIcon,
  PinIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  StoppedThreadIcon,
} from "./workbench-icons";
import WorkbenchComposerDraftPresenceProvider from "./WorkbenchComposerDraftPresenceProvider";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

const THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;
type ThreadListEntry = WorkbenchThreadSidebarEntry | WorkbenchPinnedThreadSummaryEntry;

function isPinnedDraftSummaryEntry(entry: ThreadListEntry): entry is Extract<WorkbenchPinnedThreadSummaryEntry, { entryKind: "draft" }> {
  return entry.entryKind === "draft" && "draftId" in entry;
}

function targetForEntry(entry: ThreadListEntry): WorkbenchThreadTarget {
  return entry.entryKind === "draft"
    ? { draftId: isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId, kind: "draft" }
    : { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId };
}

function boundedFolderMutationError(error: unknown) {
  return (error instanceof Error ? error.message : "The thread folder mutation failed.").slice(0, 500);
}

interface WorkbenchThreadSidebarActionsValue {
  autoFocusFolderId: string | null;
  displayOrder: WorkbenchThreadDisplayOrder;
  entries: WorkbenchThreadSidebarEntry[];
  error: string;
  getThreadContextMenu: (entry: ThreadListEntry, ownerProjectId: ProjectId, folderScope?: "pinned" | "project") => WorkbenchContextMenuDefinition;
  isLoading: boolean;
  homeDisplayOrder: WorkbenchThreadDisplayOrder;
  homeDisplayOrderSupported: boolean;
  nowMs: number;
  onAction: (entry: ThreadListEntry, action: import("./thread-row-actions").ThreadRowAction, ownerProjectId: ProjectId) => void;
  onAutoFocusFolderComplete: () => void;
  onMove: (sourceKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null, beforeKey: string | null, ownerProjectId?: ProjectId) => void;
  onProjectFolderDrop: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetKey: ThreadDisplayKey, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null) => void;
  onPinnedFolderDrop: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetKey: ThreadDisplayKey, destinationFolderId: string | null) => void;
  onSetPriority: (payload: WorkbenchThreadRowDragPayload, priority: WorkbenchThreadPriority) => void;
  onSnoozeUntil: (payload: WorkbenchThreadRowDragPayload, targetProjectId: ProjectId, targetIdentity: { harness: WorkbenchHarness; threadId: WorkbenchThreadId }) => void;
  onHomeMove: (sourceKey: string, section: WorkbenchThreadDisplaySection, destinationFolderKey: string | null, beforeKey: string | null) => void;
  onPinnedMove: (sourceKey: string, destinationFolderId: string | null, beforeKey: string | null) => void;
  onRenamePinnedFolder: (folderId: string, title: string) => Promise<string>;
  onRenameFolder: (folderId: string, title: string, ownerProjectId?: ProjectId) => Promise<string>;
  pinnedDisplayOrder: WorkbenchThreadDisplayOrder;
  projectThreadSidebars: WorkbenchProjectThreadSidebars;
  projectThreadSummaries: WorkbenchProjectThreadSummaries;
}

const WorkbenchThreadSidebarActionsContext = createContext<WorkbenchThreadSidebarActionsValue | null>(null);

function useWorkbenchThreadSidebarActions() {
  const value = useContext(WorkbenchThreadSidebarActionsContext);
  if (!value) throw new Error("Workbench thread sidebar actions require WorkbenchThreadSidebarActionsProvider.");
  return value;
}

function WorkbenchThreadSidebarActionsProvider({
  children,
  controls,
  onOpenThread,
  onThreadSettled,
  projectId,
  threadSummariesById,
}: {
  children: ReactNode;
  controls: WorkbenchControls | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  onThreadSettled: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: ProjectId | "";
  threadSummariesById: ReadonlyMap<string, ThreadSummary>;
}) {
  const currentSidebar = useWorkbenchProjectThreadSidebar(projectId);
  const projectThreadSummaries = useWorkbenchProjectThreadSummaries();
  const projectThreadSidebars = useWorkbenchProjectThreadSidebars();
  const homeThreadDisplayOrder = useWorkbenchHomeThreadDisplayOrder();
  const homeDisplayOrderSupported = useWorkbenchHomeThreadDisplayOrderSupported();
  const pinnedThreadLayout = useWorkbenchPinnedThreadLayout();
  const entries = currentSidebar?.entries ?? [];
  const entryCount = projectThreadSidebars.projects.reduce((total, sidebar) => total + sidebar.entries.length, 0);
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState(() => Date.now());
  const [autoFocusFolderId, setAutoFocusFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!entries.length) return;
    setRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => setRelativeTimeNowMs(Date.now()), THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [entryCount]);

  const stopThread = useCallback(async (thread: ThreadSummary) => {
    if (!controls) return;
    const payload = await controls.readThread(thread.id, thread.harness);
    if (payload) await controls.stopThread(payload);
  }, [controls]);

  const mutateEntry = useCallback(async (entry: ThreadListEntry, ownerProjectId: ProjectId, method: "archive/set" | "pin/set" | "restore" | "settle" | "snooze/set" | "status/set", value?: boolean | "completed" | "needsAttention" | "stopped") => {
    if (!controls || !ownerProjectId) return;
    if (entry.entryKind === "draft") {
      const draftId = isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId;
      if (method === "pin/set") void controls.updateThreadState({ draftId, method: "workbench/thread-state/draft/pin/set", pinned: Boolean(value), projectId: ownerProjectId });
      if (method === "snooze/set") void controls.updateThreadState({ draftId, method: "workbench/thread-state/draft/snooze/set", projectId: ownerProjectId, snoozed: Boolean(value) });
      return;
    }
    const identity = entry.identity;
    const request = method === "pin/set"
      ? { identity, method: "workbench/thread-state/pin/set" as const, pinned: Boolean(value), projectId: ownerProjectId }
      : method === "snooze/set"
        ? { identity, method: "workbench/thread-state/snooze/set" as const, projectId: ownerProjectId, snoozed: Boolean(value) }
        : method === "archive/set"
          ? { archived: Boolean(value), identity, method: "workbench/thread-state/archive/set" as const, projectId: ownerProjectId }
          : method === "status/set"
            ? { identity, method: "workbench/thread-state/status/set" as const, projectId: ownerProjectId, status: value === "needsAttention" ? "needsAttention" as const : value === "stopped" ? "stopped" as const : "completed" as const }
            : method === "restore"
              ? { identity, method: "workbench/thread-state/restore" as const, projectId: ownerProjectId }
              : { identity, method: "workbench/thread-state/settle" as const, projectId: ownerProjectId };
    const accepted = await controls.updateThreadStateWithAcceptance(request);
    if (method === "settle" && accepted) {
      onThreadSettled({ harness: identity.harness, kind: "provider", threadId: identity.threadId }, ownerProjectId);
    }
  }, [controls, onThreadSettled]);

  const runDragMutation = useCallback((request: Parameters<NonNullable<typeof controls>["updateThreadStateWithAcceptance"]>[0], failureLabel: string, folderId?: string) => {
    if (!controls) return;
    void controls.updateThreadStateWithAcceptance(request).then((accepted) => {
      if (!accepted && folderId) setAutoFocusFolderId((current) => current === folderId ? null : current);
    }).catch((error: unknown) => {
      if (folderId) setAutoFocusFolderId((current) => current === folderId ? null : current);
      console.error(failureLabel, boundedFolderMutationError(error));
    });
  }, [controls]);

  const getThreadContextMenu = useCallback((entry: ThreadListEntry, ownerProjectId: ProjectId, folderScope?: "pinned" | "project"): WorkbenchContextMenuDefinition => {
    const thread = entry.entryKind === "thread" && ownerProjectId === projectId ? threadSummariesById.get(entry.identity.threadId) ?? null : null;
    const identifier = entry.entryKind === "draft" ? isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId : entry.identity.threadId;
    const pinned = isPinnedDraftSummaryEntry(entry) ? true : entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
    const group = isPinnedDraftSummaryEntry(entry) ? "pinned" : getThreadSidebarGroup(entry);
    const terminal = entry.entryKind !== "draft" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped");
    const items: WorkbenchContextMenuDefinition["items"] = [{
      icon: <OpenThreadIcon size={16} />,
      id: "open",
      label: "Open",
      onSelect: () => onOpenThread(targetForEntry(entry), ownerProjectId),
    }];

    if (terminal && group !== "archived" && entry.lifecycle.settled) {
      items.push({
        icon: <RestoreThreadIcon size={16} />,
        id: "restore",
        label: "Restore",
        onSelect: () => mutateEntry(entry, ownerProjectId, "restore"),
      });
    }

    items.push({
      icon: <CopyIcon size={16} />,
      id: "copy-id",
      label: "Copy ID",
      onSelect: () => { void writeTextToClipboard(identifier); },
    });

    const localDisplayKey = isPinnedDraftSummaryEntry(entry) ? getThreadDisplayDraftKey(entry.draftId) : getWorkbenchThreadDisplayKey(entry);
    const useProjectFolder = folderScope === "project"
      || (folderScope !== "pinned" && (!projectId || group !== "pinned"));
    const displayKey = useProjectFolder ? localDisplayKey : getProjectQualifiedThreadDisplayKey(ownerProjectId, localDisplayKey);
    const ownerSidebar = projectThreadSidebars.projects.find((candidate) => candidate.projectId === ownerProjectId) ?? null;
    const folder = useProjectFolder
      ? findWorkbenchThreadFolder(ownerSidebar?.displayOrder, displayKey)
      : findWorkbenchThreadFolder(pinnedThreadLayout.displayOrder, displayKey);
    if (entry.entryKind !== "subagent" && (group === "pinned" || group === "snoozed" || group === "settled") && !folder) {
      items.push({
        icon: <FolderInputIcon size={16} />,
        id: "add-to-folder",
        label: "Add to folder",
        onSelect: () => {
          if (!controls) return;
          const folderId = FolderIdSchema.parse(crypto.randomUUID());
          setAutoFocusFolderId(folderId);
          const request = group === "pinned" && !useProjectFolder
            ? { folderId, method: "workbench/thread-state/pinned-display-order/folder/create" as const, sourceKey: displayKey, title: "New folder" }
            : { folderId, method: "workbench/thread-state/display-order/folder/create" as const, projectId: ownerProjectId, sourceKey: localDisplayKey, title: "New folder" };
          void controls.updateThreadStateWithAcceptance(request).then((accepted) => {
            if (!accepted) setAutoFocusFolderId((current) => current === folderId ? null : current);
          }).catch((error: unknown) => {
            setAutoFocusFolderId((current) => current === folderId ? null : current);
            console.error("Unable to create the thread folder.", boundedFolderMutationError(error));
          });
        },
      });
    }

    const snoozed = group === "snoozed";
    items.push({ id: "priority-separator", kind: "separator" }, {
      closeOnSelect: false,
      controls: [{
        checked: pinned,
        disabled: group === "archived",
        icon: <PinIcon size={16} />,
        id: "pin",
        label: pinned ? "Unpin thread" : "Pin thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "pin/set", !pinned),
      }, {
        checked: snoozed,
        disabled: group === "archived" || (entry.entryKind !== "draft" && entry.lifecycle.settled),
        icon: <SnoozedThreadIcon size={16} />,
        id: "snooze",
        label: snoozed ? "Wake" : "Snooze thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "snooze/set", !snoozed),
      }],
      id: "priority",
      kind: "control-group",
      label: "Priority",
      presentation: "independent",
    });

    if (entry.entryKind === "thread") {
      const providerOwned = isWorkbenchThreadStatusProviderOwned(entry.lifecycle);
      const canComplete = isWorkbenchSidebarThreadCompletionAvailable(entry);
      const selectStatus = (status: "completed" | "needsAttention" | "stopped") => {
        if (providerOwned && !(status === "completed" && canComplete)) {
          if (status === "stopped" && thread) void stopThread(thread);
          return;
        }
        if (entry.lifecycle.kind !== status) mutateEntry(entry, ownerProjectId, "status/set", status);
      };
      items.push({ id: "status-separator", kind: "separator" }, {
        closeOnSelect: false,
        controls: [{
          checked: entry.lifecycle.kind === "needsAttention",
          disabled: group === "archived" || entry.lifecycle.kind === "working",
          icon: <NeedsAttentionThreadIcon size={16} />,
          id: "needs-attention",
          label: "Needs attention",
          onSelect: () => selectStatus("needsAttention"),
          tone: getNeedsAttentionThreadStatusTone(!entry.metadata.snoozed),
        }, {
          checked: entry.lifecycle.kind === "completed",
          disabled: group === "archived" || (providerOwned && !canComplete),
          icon: <CompletedThreadIcon size={16} />,
          id: "completed",
          label: "Completed",
          onSelect: () => selectStatus("completed"),
          tone: "completed",
        }, {
          checked: entry.lifecycle.kind === "stopped",
          disabled: group === "archived" || (providerOwned && !thread),
          icon: <StoppedThreadIcon size={16} />,
          id: "stopped",
          label: "Stopped",
          onSelect: () => selectStatus("stopped"),
          tone: "stopped",
        }],
        id: "status",
        kind: "control-group",
        label: "Status",
        presentation: "connected",
      });
    }

    if (group === "archived" || (entry.entryKind !== "draft" && isWorkbenchThreadSettlementAvailable(entry))) {
      items.push({ id: "conclude-separator", kind: "separator" }, {
        controls: group === "archived" ? [{
          checked: false,
          icon: <RestoreThreadIcon size={16} />,
          id: "restore",
          label: "Restore",
          onSelect: () => mutateEntry(entry, ownerProjectId, "restore"),
        }] : [
          {
            checked: false,
            icon: <SettleThreadIcon size={16} />,
            id: "settle",
            label: "Settle",
            onSelect: () => mutateEntry(entry, ownerProjectId, "settle"),
          },
          {
            checked: false,
            icon: <ArchiveIcon size={16} />,
            id: "archive",
            label: "Archive",
            onSelect: () => mutateEntry(entry, ownerProjectId, "archive/set", true),
          },
        ],
        id: "conclude",
        kind: "control-group",
        label: "Conclude",
        presentation: "actions",
      });
    }
    return { id: `thread:${identifier}`, items, label: `Thread actions for ${entry.title}`, placementScope: "thread-list" };
  }, [controls, mutateEntry, onOpenThread, pinnedThreadLayout.displayOrder, projectId, projectThreadSidebars.projects, stopThread, threadSummariesById]);

  const value = useMemo<WorkbenchThreadSidebarActionsValue>(() => ({
    autoFocusFolderId,
    displayOrder: currentSidebar?.displayOrder ?? {},
    entries,
    error: currentSidebar?.error ?? "",
    getThreadContextMenu,
    homeDisplayOrder: homeThreadDisplayOrder.displayOrder,
    homeDisplayOrderSupported,
    isLoading: !currentSidebar && !projectThreadSidebars.projects.length,
    nowMs: relativeTimeNowMs,
    onAction: (entry, action, ownerProjectId) => {
      if (entry.entryKind === "draft") {
        if (action === "discard" && !isPinnedDraftSummaryEntry(entry)) void controls?.deleteThreadDraft(entry.draft.draftId);
        return;
      }
      if (action === "discard") return;
      const mutations = {
        archive: () => mutateEntry(entry, ownerProjectId, "archive/set", true),
        complete: () => mutateEntry(entry, ownerProjectId, "status/set", "completed"),
        restore: () => mutateEntry(entry, ownerProjectId, "restore"),
        settle: () => mutateEntry(entry, ownerProjectId, "settle"),
        snooze: () => mutateEntry(entry, ownerProjectId, "snooze/set", true),
        wake: () => mutateEntry(entry, ownerProjectId, "snooze/set", false),
      };
      void mutations[action]().catch(error => console.error("Thread action failed", boundedFolderMutationError(error)));
    },
    onAutoFocusFolderComplete: () => setAutoFocusFolderId(null),
    onMove: (sourceKey, section, destinationFolderId, beforeKey, ownerProjectId = projectId || undefined) => {
      if (!ownerProjectId) return;
      void controls?.updateThreadStateWithAcceptance({
        beforeKey,
        destinationFolderId,
        method: "workbench/thread-state/display-order/move",
        projectId: ownerProjectId,
        section,
        sourceKey,
      });
    },
    onProjectFolderDrop: (payload, targetProjectId, targetKey, section, destinationFolderId) => {
      if (payload.ownerProjectId !== targetProjectId) return;
      const folderId = destinationFolderId ? null : crypto.randomUUID();
      if (folderId) setAutoFocusFolderId(folderId);
      runDragMutation({
        destinationFolderId,
        folderId,
        method: "workbench/thread-state/display-order/folder/drop",
        projectId: targetProjectId,
        section,
        sourceKey: payload.projectSourceKey,
        targetKey,
      }, "Unable to group the dragged thread.", folderId ?? undefined);
    },
    onPinnedFolderDrop: (payload, targetProjectId, targetKey, destinationFolderId) => {
      const folderId = destinationFolderId ? null : crypto.randomUUID();
      if (folderId) setAutoFocusFolderId(folderId);
      runDragMutation({
        destinationFolderId,
        folderId,
        method: "workbench/thread-state/pinned-display-order/folder/drop",
        sourceKey: getProjectQualifiedThreadDisplayKey(payload.ownerProjectId, payload.projectSourceKey),
        targetKey: getProjectQualifiedThreadDisplayKey(targetProjectId, targetKey),
      }, "Unable to group the dragged pinned thread.", folderId ?? undefined);
    },
    onSetPriority: (payload, priority) => {
      runDragMutation({
        method: "workbench/thread-state/priority/set",
        priority,
        projectId: payload.ownerProjectId,
        sourceKey: payload.projectSourceKey,
      }, "Unable to change the dragged thread priority.");
    },
    onSnoozeUntil: (payload, targetProjectId, targetIdentity) => {
      const source = payload.target.kind === "thread" ? payload.target.target : null;
      if (source?.kind !== "provider" || !source.harness) return;
      runDragMutation({
        identity: { harness: source.harness, threadId: source.threadId },
        method: "workbench/thread-state/snooze/until",
        projectId: payload.ownerProjectId,
        target: { identity: targetIdentity, projectId: targetProjectId },
      }, "Unable to snooze the dragged thread until its target completes.");
    },
    onHomeMove: (sourceKey, section, destinationFolderKey, beforeKey) => {
      void controls?.updateThreadStateWithAcceptance({
        beforeKey,
        destinationFolderKey,
        method: "workbench/thread-state/home-display-order/move",
        section,
        sourceKey,
      });
    },
    onPinnedMove: (sourceKey, destinationFolderId, beforeKey) => {
      void controls?.updateThreadStateWithAcceptance({
        beforeKey,
        destinationFolderId,
        method: "workbench/thread-state/pinned-display-order/move",
        sourceKey,
      });
    },
    onRenamePinnedFolder: async (folderId, title) => {
      const accepted = await controls?.updateThreadStateWithAcceptance({
        folderId,
        method: "workbench/thread-state/pinned-display-order/folder/title/set",
        title,
      });
      if (!accepted) throw new Error("Unable to update the pinned thread folder name.");
      return title.trim();
    },
    onRenameFolder: async (folderId, title, ownerProjectId = projectId || undefined) => {
      if (!ownerProjectId) throw new Error("A project must be selected before renaming a folder.");
      const accepted = await controls?.updateThreadStateWithAcceptance({
        folderId,
        method: "workbench/thread-state/display-order/folder/title/set",
        projectId: ownerProjectId,
        title,
      });
      if (!accepted) throw new Error("Unable to update the folder name.");
      return title.trim();
    },
    pinnedDisplayOrder: pinnedThreadLayout.displayOrder,
    projectThreadSidebars,
    projectThreadSummaries,
  }), [autoFocusFolderId, controls, currentSidebar, entries, getThreadContextMenu, homeDisplayOrderSupported, homeThreadDisplayOrder.displayOrder, mutateEntry, pinnedThreadLayout.displayOrder, projectId, projectThreadSidebars, projectThreadSummaries, relativeTimeNowMs, runDragMutation]);

  return (
    <WorkbenchComposerDraftPresenceProvider>
      <WorkbenchThreadSidebarActionsContext.Provider value={value}>
        {children}
      </WorkbenchThreadSidebarActionsContext.Provider>
    </WorkbenchComposerDraftPresenceProvider>
  );
}

export default Object.assign(WorkbenchThreadSidebarActionsProvider, {
  useActions: useWorkbenchThreadSidebarActions,
});
