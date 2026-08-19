/*
 * Exports:
 * - default WorkbenchThreadSidebar: render the live thread list without subscribing the Workbench root. Keywords: sidebar, threads, activity, React.
 */
"use client";

import { memo, useCallback, useEffect, useState, useSyncExternalStore, type PointerEvent } from "react";

import type { ThreadSummary, WorkbenchControls, WorkbenchHarness, WorkbenchThreadSidebarStore } from "../../lib/types";
import { writeTextToClipboard } from "../../lib/workbench/dom/clipboard";
import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import { createThreadHref } from "../../lib/workbench/navigation/workbench-route";
import type { WorkbenchThreadTarget } from "../../lib/workbench/thread/thread-state";
import { getThreadSidebarGroup, isWorkbenchThreadStatusProviderOwned, type WorkbenchThreadSidebarEntry } from "../../lib/workbench/thread/thread-state";
import { SidebarLoadingSkeleton } from "./workbench-explorer";
import {
  ArchiveIcon,
  CompletedThreadIcon,
  CopyIcon,
  NeedsAttentionThreadIcon,
  OpenThreadIcon,
  PinIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  StoppedThreadIcon,
} from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchThreadList from "./WorkbenchThreadList";

const THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;
const EMPTY_UNSUBSCRIBE = () => {};

function useThreadSidebarSelection<T>(
  store: WorkbenchThreadSidebarStore | null,
  selector: (snapshot: ReturnType<WorkbenchThreadSidebarStore["getSnapshot"]>) => T,
) {
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE, [store]);
  const getSelection = useCallback(() => selector(store?.getSnapshot() ?? null), [selector, store]);
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

interface WorkbenchThreadSidebarProps {
  attentionLabelsByThreadId: Record<string, string | undefined>;
  controls: WorkbenchControls | null;
  currentTarget: WorkbenchThreadTarget | null;
  harness: WorkbenchHarness;
  onBeginPointerDrag: (event: PointerEvent<HTMLElement>, payload: WorkbenchDragPayload) => void;
  onCreateThread: () => void;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: string;
  showMosaicView: boolean;
  store: WorkbenchThreadSidebarStore | null;
  threadSummariesById: ReadonlyMap<string, ThreadSummary>;
}

export default memo(function WorkbenchThreadSidebar({
  attentionLabelsByThreadId,
  controls,
  currentTarget,
  harness,
  onBeginPointerDrag,
  onCreateThread,
  onOpenThread,
  projectId,
  showMosaicView,
  store,
  threadSummariesById,
}: WorkbenchThreadSidebarProps) {
  const selectSnapshot = useCallback((snapshot: ReturnType<WorkbenchThreadSidebarStore["getSnapshot"]>) => snapshot, []);
  const snapshot = useThreadSidebarSelection(store, selectSnapshot);
  const entries = snapshot?.entries ?? [];
  const hasEntries = entries.length > 0;
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasEntries) return;
    setRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setRelativeTimeNowMs(Date.now());
    }, THREAD_RELATIVE_TIME_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasEntries]);

  const stopThread = useCallback(async (thread: ThreadSummary) => {
    if (!controls) return;
    const payload = await controls.readThread(thread.id, thread.harness);
    if (payload) await controls.stopThread(payload);
  }, [controls]);

  const mutateEntry = useCallback((entry: WorkbenchThreadSidebarEntry, method: "archive/set" | "pin/set" | "restore" | "settle" | "snooze/set" | "status/set", value?: boolean | "completed" | "needsAttention" | "stopped") => {
    if (!controls || !projectId) return;
    if (entry.entryKind === "draft") {
      if (method === "pin/set") void controls.updateThreadState({ draftId: entry.draft.draftId, method: "workbench/thread-state/draft/pin/set", pinned: Boolean(value), projectId });
      if (method === "snooze/set") void controls.updateThreadState({ draftId: entry.draft.draftId, method: "workbench/thread-state/draft/snooze/set", projectId, snoozed: Boolean(value) });
      return;
    }
    const identity = entry.identity;
    const request = method === "pin/set"
      ? { identity, method: "workbench/thread-state/pin/set" as const, pinned: Boolean(value), projectId }
      : method === "snooze/set"
        ? { identity, method: "workbench/thread-state/snooze/set" as const, projectId, snoozed: Boolean(value) }
        : method === "archive/set"
          ? { archived: Boolean(value), identity, method: "workbench/thread-state/archive/set" as const, projectId }
          : method === "status/set"
            ? { identity, method: "workbench/thread-state/status/set" as const, projectId, status: value === "needsAttention" ? "needsAttention" as const : value === "stopped" ? "stopped" as const : "completed" as const }
            : method === "restore"
              ? { identity, method: "workbench/thread-state/restore" as const, projectId }
              : { identity, method: "workbench/thread-state/settle" as const, projectId };
    void controls.updateThreadState(request);
  }, [controls, projectId]);

  const getThreadContextMenu = useCallback((entry: WorkbenchThreadSidebarEntry): WorkbenchContextMenuDefinition => {
    const thread = entry.entryKind === "thread" ? threadSummariesById.get(entry.identity.threadId) ?? null : null;
    const identifier = entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId;
    const pinned = entry.entryKind === "draft" ? entry.metadata.pinned : entry.entryKind === "thread" ? entry.metadata.pinned : entry.pinned;
    const group = getThreadSidebarGroup(entry);
    const terminal = entry.entryKind !== "draft" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped");
    const target = entry.entryKind === "draft"
      ? { draftId: entry.draft.draftId, kind: "draft" as const }
      : { harness: entry.identity.harness, kind: "provider" as const, threadId: entry.identity.threadId };
    const items: WorkbenchContextMenuDefinition["items"] = [{
      icon: <OpenThreadIcon className="size-4" />,
      id: "open",
      label: "Open",
      onSelect: () => onOpenThread(target),
    }];

    if (terminal && (entry.lifecycle.settled || !entry.fileClaim)) {
      items.push(entry.lifecycle.settled ? {
        icon: <RestoreThreadIcon className="size-4" />,
        id: "restore",
        label: "Restore",
        onSelect: () => mutateEntry(entry, "restore"),
      } : {
        icon: <SettleThreadIcon className="size-4" />,
        id: "settle",
        label: "Settle",
        onSelect: () => mutateEntry(entry, "settle"),
      });
    }

    items.push({
      icon: <CopyIcon className="size-4" />,
      id: "copy-id",
      label: "Copy ID",
      onSelect: () => { void writeTextToClipboard(identifier); },
    });

    const snoozed = group === "snoozed";
    items.push({ id: "priority-separator", kind: "separator" }, {
      controls: [{
        checked: pinned,
        icon: <PinIcon className="size-4" />,
        id: "pin",
        label: pinned ? "Unpin thread" : "Pin thread",
        onSelect: () => mutateEntry(entry, "pin/set", !pinned),
      }, {
        checked: snoozed,
        disabled: entry.entryKind !== "draft" && entry.lifecycle.settled,
        icon: <SnoozedThreadIcon className="size-4" />,
        id: "snooze",
        label: snoozed ? "Wake" : "Snooze thread",
        onSelect: () => mutateEntry(entry, "snooze/set", !snoozed),
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
        if (entry.lifecycle.kind !== status) mutateEntry(entry, "status/set", status);
      };
      items.push({ id: "status-separator", kind: "separator" }, {
        controls: [{
          checked: entry.lifecycle.kind === "needsAttention",
          disabled: entry.lifecycle.kind === "working",
          icon: <NeedsAttentionThreadIcon className="size-4" />,
          id: "needs-attention",
          label: "Needs attention",
          onSelect: () => selectStatus("needsAttention"),
          tone: "needs-attention",
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
        onSelect: () => mutateEntry(entry, "archive/set", true),
        tone: "danger",
      });
    }
    return { id: `thread:${identifier}`, items, label: `Thread actions for ${entry.title}` };
  }, [mutateEntry, onOpenThread, stopThread, threadSummariesById]);

  const isMatchingSnapshot = snapshot?.projectId === projectId;
  if (!snapshot || !isMatchingSnapshot || (snapshot.freshness === "loading" && snapshot.entries.length === 0)) {
    return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  }
  const error = snapshot.error ?? "";

  return (
    <>
      <nav aria-label="Threads">
        <WorkbenchThreadList
          attentionLabelsByThreadId={attentionLabelsByThreadId}
          createThreadLabel="Create new thread"
          currentTarget={currentTarget}
          entries={entries}
          getThreadHref={(target) => createThreadHref(projectId, target)}
          getThreadContextMenu={getThreadContextMenu}
          nowMs={relativeTimeNowMs}
          onAction={(entry, action) => {
            if (entry.entryKind === "draft") {
              if (action === "discard") void controls?.deleteThreadDraft(entry.draft.draftId);
              return;
            }
            if (action === "complete") mutateEntry(entry, "status/set", "completed");
            if (action === "settle") mutateEntry(entry, "settle");
            if (action === "restore") mutateEntry(entry, "restore");
            if (action === "wake") mutateEntry(entry, "snooze/set", false);
          }}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onOpenThread={onOpenThread}
          projectId={projectId}
          onThreadPointerDragStart={(event, entry) => {
            const target = entry.entryKind === "draft"
              ? { draftId: entry.draft.draftId, kind: "draft" as const }
              : { harness: entry.identity.harness, kind: "provider" as const, threadId: entry.identity.threadId };
            onBeginPointerDrag(event, { target: { kind: "thread", target }, type: "panel-target" });
          }}
        />
      </nav>
      {error ? <p className="m-0 pr-2 text-[0.84rem] leading-6 text-muted">{error}</p> : null}
    </>
  );
});
