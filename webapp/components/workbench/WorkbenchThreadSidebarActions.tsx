/*
 * Exports:
 * - default WorkbenchThreadSidebarActionsProvider: own shared thread-sidebar subscriptions, mutations, menus, folder focus, relative time, and expose the colocated context hook. Keywords: sidebar, actions, context, threads.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import type { ThreadSummary, WorkbenchControls, WorkbenchThreadSidebarStore } from "../../lib/types";
import { writeTextToClipboard } from "../../lib/workbench/dom/clipboard";
import { findWorkbenchThreadFolder, getWorkbenchThreadDisplayKey, type WorkbenchThreadDisplayOrder, type WorkbenchThreadDisplaySection } from "../../lib/workbench/thread/thread-display-order";
import { getProjectQualifiedThreadDisplayKey } from "../../lib/workbench/thread/thread-display-layout";
import {
  getThreadSidebarGroup,
  isWorkbenchThreadSettlementAvailable,
  isWorkbenchThreadStatusProviderOwned,
  type WorkbenchPinnedThreadSummaryEntry,
  type WorkbenchProjectThreadSummaries,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadTarget,
} from "../../lib/workbench/thread/thread-state";
import { getNeedsAttentionThreadStatusTone } from "./workbench-thread-status-colors";
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
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

const THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;
const EMPTY_UNSUBSCRIBE = () => {};
const EMPTY_PROJECT_THREAD_SUMMARIES: WorkbenchProjectThreadSummaries = { projects: [] };
const EMPTY_PINNED_THREAD_LAYOUT = { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" as const };
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
  getThreadContextMenu: (entry: ThreadListEntry, ownerProjectId: string) => WorkbenchContextMenuDefinition;
  isLoading: boolean;
  nowMs: number;
  onAction: (entry: ThreadListEntry, action: "complete" | "discard" | "restore" | "settle" | "wake", ownerProjectId: string) => void;
  onAutoFocusFolderComplete: () => void;
  onMove: (sourceKey: string, section: WorkbenchThreadDisplaySection, destinationFolderId: string | null, beforeKey: string | null) => void;
  onPinnedMove: (sourceKey: string, destinationFolderId: string | null, beforeKey: string | null) => void;
  onRenamePinnedFolder: (folderId: string, title: string) => Promise<string>;
  onRenameFolder: (folderId: string, title: string) => Promise<string>;
  pinnedDisplayOrder: WorkbenchThreadDisplayOrder;
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
  store,
  threadSummariesById,
}: {
  children: ReactNode;
  controls: WorkbenchControls | null;
  onOpenThread: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  onThreadSettled: (target: WorkbenchThreadTarget, ownerProjectId?: string) => void;
  projectId: string;
  store: WorkbenchThreadSidebarStore | null;
  threadSummariesById: ReadonlyMap<string, ThreadSummary>;
}) {
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => EMPTY_UNSUBSCRIBE),
    store?.getSnapshot ?? (() => null),
    () => null,
  );
  const projectThreadSummaries = useSyncExternalStore(
    store?.subscribe ?? (() => EMPTY_UNSUBSCRIBE),
    store?.getProjectThreadSummaries ?? (() => EMPTY_PROJECT_THREAD_SUMMARIES),
    () => EMPTY_PROJECT_THREAD_SUMMARIES,
  );
  const pinnedThreadLayout = useSyncExternalStore(
    store?.subscribe ?? (() => EMPTY_UNSUBSCRIBE),
    store?.getPinnedThreadLayout ?? (() => EMPTY_PINNED_THREAD_LAYOUT),
    () => EMPTY_PINNED_THREAD_LAYOUT,
  );
  const entries = snapshot?.projectId === projectId ? snapshot.entries : [];
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState(() => Date.now());
  const [autoFocusFolderId, setAutoFocusFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!entries.length) return;
    setRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => setRelativeTimeNowMs(Date.now()), THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [entries.length]);

  const stopThread = useCallback(async (thread: ThreadSummary) => {
    if (!controls) return;
    const payload = await controls.readThread(thread.id, thread.harness);
    if (payload) await controls.stopThread(payload);
  }, [controls]);

  const mutateEntry = useCallback(async (entry: ThreadListEntry, ownerProjectId: string, method: "archive/set" | "pin/set" | "restore" | "settle" | "snooze/set" | "status/set", value?: boolean | "completed" | "needsAttention" | "stopped") => {
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

  const getThreadContextMenu = useCallback((entry: ThreadListEntry, ownerProjectId: string): WorkbenchContextMenuDefinition => {
    const thread = entry.entryKind === "thread" && ownerProjectId === projectId ? threadSummariesById.get(entry.identity.threadId) ?? null : null;
    const identifier = entry.entryKind === "draft" ? isPinnedDraftSummaryEntry(entry) ? entry.draftId : entry.draft.draftId : entry.identity.threadId;
    const pinned = isPinnedDraftSummaryEntry(entry) ? true : entry.entryKind === "subagent" ? entry.pinned : entry.metadata.pinned;
    const group = isPinnedDraftSummaryEntry(entry) ? "pinned" : getThreadSidebarGroup(entry);
    const terminal = entry.entryKind !== "draft" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped");
    const items: WorkbenchContextMenuDefinition["items"] = [{
      icon: <OpenThreadIcon className="size-4" />,
      id: "open",
      label: "Open",
      onSelect: () => onOpenThread(targetForEntry(entry), ownerProjectId),
    }];

    if (terminal && (entry.lifecycle.settled || isWorkbenchThreadSettlementAvailable(entry))) {
      items.push(entry.lifecycle.settled ? {
        icon: <RestoreThreadIcon className="size-4" />,
        id: "restore",
        label: "Restore",
        onSelect: () => mutateEntry(entry, ownerProjectId, "restore"),
      } : {
        icon: <SettleThreadIcon className="size-4" />,
        id: "settle",
        label: "Settle",
        onSelect: () => mutateEntry(entry, ownerProjectId, "settle"),
      });
    }

    items.push({
      icon: <CopyIcon className="size-4" />,
      id: "copy-id",
      label: "Copy ID",
      onSelect: () => { void writeTextToClipboard(identifier); },
    });

    const localDisplayKey = isPinnedDraftSummaryEntry(entry) ? `draft:${entry.draftId}` : getWorkbenchThreadDisplayKey(entry);
    const displayKey = group === "pinned" ? getProjectQualifiedThreadDisplayKey(ownerProjectId, localDisplayKey) : localDisplayKey;
    const folder = group === "pinned"
      ? findWorkbenchThreadFolder(pinnedThreadLayout.displayOrder, displayKey)
      : ownerProjectId === projectId ? findWorkbenchThreadFolder(snapshot?.displayOrder, displayKey) : null;
    if (entry.entryKind !== "subagent" && (group === "pinned" || ((group === "snoozed" || group === "settled") && ownerProjectId === projectId)) && !folder) {
      items.push({
        icon: <FolderInputIcon className="size-4" />,
        id: "add-to-folder",
        label: "Add to folder",
        onSelect: () => {
          if (!controls) return;
          const folderId = crypto.randomUUID();
          setAutoFocusFolderId(folderId);
          const request = group === "pinned"
            ? { folderId, method: "workbench/thread-state/pinned-display-order/folder/create" as const, sourceKey: displayKey, title: "New folder" }
            : { folderId, method: "workbench/thread-state/display-order/folder/create" as const, projectId: ownerProjectId, sourceKey: displayKey, title: "New folder" };
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
      controls: [{
        checked: pinned,
        icon: <PinIcon className="size-4" />,
        id: "pin",
        label: pinned ? "Unpin thread" : "Pin thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "pin/set", !pinned),
      }, {
        checked: snoozed,
        disabled: entry.entryKind !== "draft" && entry.lifecycle.settled,
        icon: <SnoozedThreadIcon className="size-4" />,
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
      const selectStatus = (status: "completed" | "needsAttention" | "stopped") => {
        if (providerOwned) {
          if (status === "stopped" && thread) void stopThread(thread);
          return;
        }
        if (entry.lifecycle.kind !== status) mutateEntry(entry, ownerProjectId, "status/set", status);
      };
      items.push({ id: "status-separator", kind: "separator" }, {
        controls: [{
          checked: entry.lifecycle.kind === "needsAttention",
          disabled: entry.lifecycle.kind === "working",
          icon: <NeedsAttentionThreadIcon className="size-4" />,
          id: "needs-attention",
          label: "Needs attention",
          onSelect: () => selectStatus("needsAttention"),
          tone: getNeedsAttentionThreadStatusTone(entry.gitArc?.phase === "active"),
        }, {
          checked: entry.lifecycle.kind === "completed",
          disabled: providerOwned,
          icon: <CompletedThreadIcon className="size-4" />,
          id: "completed",
          label: "Completed",
          onSelect: () => selectStatus("completed"),
          tone: "completed",
        }, {
          checked: entry.lifecycle.kind === "stopped",
          disabled: providerOwned && !thread,
          icon: <StoppedThreadIcon className="size-4" />,
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

    if (terminal) {
      items.push({ id: "archive-separator", kind: "separator" }, {
        icon: <ArchiveIcon className="size-4" />,
        id: "archive",
        label: "Archive thread",
        onSelect: () => mutateEntry(entry, ownerProjectId, "archive/set", true),
        tone: "danger",
      });
    }
    return { id: `thread:${identifier}`, items, label: `Thread actions for ${entry.title}` };
  }, [controls, mutateEntry, onOpenThread, pinnedThreadLayout.displayOrder, projectId, snapshot?.displayOrder, stopThread, threadSummariesById]);

  const value = useMemo<WorkbenchThreadSidebarActionsValue>(() => ({
    autoFocusFolderId,
    displayOrder: snapshot?.projectId === projectId ? snapshot.displayOrder ?? {} : {},
    entries,
    error: snapshot?.projectId === projectId ? snapshot.error ?? "" : "",
    getThreadContextMenu,
    isLoading: !snapshot || snapshot.projectId !== projectId || (snapshot.freshness === "loading" && !entries.length),
    nowMs: relativeTimeNowMs,
    onAction: (entry, action, ownerProjectId) => {
      if (entry.entryKind === "draft") {
        if (action === "discard" && ownerProjectId === projectId && !isPinnedDraftSummaryEntry(entry)) void controls?.deleteThreadDraft(entry.draft.draftId);
        return;
      }
      if (action === "complete") void mutateEntry(entry, ownerProjectId, "status/set", "completed");
      if (action === "settle") void mutateEntry(entry, ownerProjectId, "settle");
      if (action === "restore") void mutateEntry(entry, ownerProjectId, "restore");
      if (action === "wake") void mutateEntry(entry, ownerProjectId, "snooze/set", false);
    },
    onAutoFocusFolderComplete: () => setAutoFocusFolderId(null),
    onMove: (sourceKey, section, destinationFolderId, beforeKey) => {
      void controls?.updateThreadStateWithAcceptance({
        beforeKey,
        destinationFolderId,
        method: "workbench/thread-state/display-order/move",
        projectId,
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
    onRenameFolder: async (folderId, title) => {
      const accepted = await controls?.updateThreadStateWithAcceptance({
        folderId,
        method: "workbench/thread-state/display-order/folder/title/set",
        projectId,
        title,
      });
      if (!accepted) throw new Error("Unable to update the folder name.");
      return title.trim();
    },
    pinnedDisplayOrder: pinnedThreadLayout.displayOrder,
    projectThreadSummaries,
  }), [autoFocusFolderId, controls, entries, getThreadContextMenu, mutateEntry, pinnedThreadLayout.displayOrder, projectId, projectThreadSummaries, relativeTimeNowMs, snapshot]);

  return <WorkbenchThreadSidebarActionsContext.Provider value={value}>{children}</WorkbenchThreadSidebarActionsContext.Provider>;
}

export default Object.assign(WorkbenchThreadSidebarActionsProvider, {
  useActions: useWorkbenchThreadSidebarActions,
});
