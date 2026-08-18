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
import { getThreadSidebarGroup, type WorkbenchThreadSidebarEntry } from "../../lib/workbench/thread/thread-state";
import { SidebarLoadingSkeleton, ThreadsList } from "./workbench-explorer";
import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  NeedsAttentionThreadIcon,
  PinIcon,
  RestoreThreadIcon,
  SettleThreadIcon,
  SnoozedThreadIcon,
  StopIcon,
  UnsnoozeThreadIcon,
} from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

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

function isThreadSummaryActive(thread: ThreadSummary) {
  return thread.status === "active"
    || thread.status.startsWith("active:")
    || Boolean(thread.unreadBadge?.hasActiveTurn);
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

  const mutateEntry = useCallback((entry: WorkbenchThreadSidebarEntry, method: "archive/set" | "attention/mark" | "complete" | "pin/set" | "restore" | "settle" | "snooze/set", value?: boolean | "completed" | "stopped") => {
    if (!controls || !projectId || entry.entryKind === "draft") return;
    const identity = entry.identity;
    const request = method === "pin/set"
      ? { identity, method: "workbench/thread-state/pin/set" as const, pinned: Boolean(value), projectId }
      : method === "snooze/set"
        ? { identity, method: "workbench/thread-state/snooze/set" as const, projectId, snoozed: Boolean(value) }
        : method === "archive/set"
          ? { archived: Boolean(value), identity, method: "workbench/thread-state/archive/set" as const, projectId }
          : method === "attention/mark"
            ? { identity, method: "workbench/thread-state/attention/mark" as const, projectId }
            : method === "complete"
            ? { identity, method: "workbench/thread-state/complete" as const, projectId, status: value === "stopped" ? "stopped" as const : "completed" as const }
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
    const items: WorkbenchContextMenuDefinition["items"] = [
      {
        icon: <CopyIcon className="size-4" />,
        id: "copy-id",
        label: "Copy ID",
        onSelect: () => { void writeTextToClipboard(identifier); },
      },
      ...(thread?.unreadBadge?.unreadCount ? [{
        icon: <CheckIcon className="size-4" />,
        id: "mark-read",
        label: "Mark as read",
        onSelect: () => {
          void (async () => {
            const payload = await controls?.readThread(thread.id, thread.harness);
            if (payload) controls?.markThreadSeen(payload);
          })();
        },
      }] : []),
      ...(entry.entryKind !== "draft" ? [{
        icon: <PinIcon className="size-4" />,
        id: pinned ? "unpin" : "pin",
        label: pinned ? "Unpin thread" : "Pin thread",
        onSelect: () => mutateEntry(entry, "pin/set", !pinned),
      }] : []),
      ...(entry.entryKind !== "draft" && (group === "snoozed" || !entry.lifecycle.settled) ? [{
        icon: group === "snoozed" ? <UnsnoozeThreadIcon className="size-4" /> : <SnoozedThreadIcon className="size-4" />,
        id: group === "snoozed" ? "unsnooze" : "snooze",
        label: group === "snoozed" ? "Unsnooze" : "Snooze",
        onSelect: () => mutateEntry(entry, "snooze/set", group !== "snoozed"),
      }] : []),
      ...(entry.entryKind === "thread" && entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "noActiveTurn" ? [{
        icon: <CheckIcon className="size-4" />, id: "mark-completed", label: "Complete", onSelect: () => mutateEntry(entry, "complete", "completed"),
      }, {
        icon: <StopIcon className="size-4" />, id: "mark-stopped", label: "Stop", onSelect: () => mutateEntry(entry, "complete", "stopped"),
      }] : []),
      ...(entry.entryKind === "thread" && terminal ? [{
        icon: <NeedsAttentionThreadIcon className="size-4" />,
        id: "mark-needs-attention",
        label: "Needs attention",
        onSelect: () => mutateEntry(entry, "attention/mark"),
      }] : []),
      ...(thread && isThreadSummaryActive(thread) ? [{
        icon: <StopIcon className="size-4" />,
        id: "stop",
        label: "Stop thread",
        onSelect: () => { void stopThread(thread); },
      }] : []),
      ...(terminal && entry.lifecycle.settled ? [{
        icon: <RestoreThreadIcon className="size-4" />, id: "restore", label: "Restore", onSelect: () => mutateEntry(entry, "restore"),
      }] : terminal ? [{
        icon: <SettleThreadIcon className="size-4" />, id: "settle", label: "Settle", onSelect: () => mutateEntry(entry, "settle"),
      }] : []),
      ...(terminal ? [{
        icon: <ArchiveIcon className="size-4" />,
        id: "archive",
        label: "Archive thread",
        onSelect: () => mutateEntry(entry, "archive/set", true),
        tone: "danger" as const,
      }] : []),
    ];
    return { id: `thread:${identifier}`, items, label: `Thread actions for ${entry.title}` };
  }, [controls, mutateEntry, stopThread, threadSummariesById]);

  const isMatchingSnapshot = snapshot?.projectId === projectId;
  if (!snapshot || !isMatchingSnapshot || (snapshot.freshness === "loading" && snapshot.entries.length === 0)) {
    return <SidebarLoadingSkeleton ariaLabel="Loading threads" rows={5} />;
  }
  const error = snapshot.error ?? "";

  return (
    <>
      <nav aria-label="Threads">
        <ThreadsList
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
            if (action === "settle") mutateEntry(entry, "settle");
            if (action === "restore") mutateEntry(entry, "restore");
            if (action === "unsnooze") mutateEntry(entry, "snooze/set", false);
          }}
          onCreateThread={onCreateThread}
          onCreateThreadPointerDragStart={showMosaicView ? (event) => {
            onBeginPointerDrag(event, { harness, type: "new-thread" });
          } : undefined}
          onOpenThread={onOpenThread}
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
