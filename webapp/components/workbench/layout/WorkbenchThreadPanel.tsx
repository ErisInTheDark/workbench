/*
 * Exports:
 * - default WorkbenchThreadPanel: hydrate and render one thread target inside a split panel. Keywords: workbench, thread panel, split layout.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps, type PointerEvent } from "react";

import type { ThreadPayload, ThreadSummary, WorkbenchThreadHydrationRequest } from "../../../lib/types";
import ThreadLoadingSkeleton from "../thread-view/ThreadLoadingSkeleton";
import ThreadView from "../thread-view/ThreadView";
import { formatThreadRelativeTimestamp, getThreadTitle } from "../thread-view/thread-view-primitives";
import useThreadActivityTimestamp from "../thread-view/use-thread-activity-timestamp";
import { workbenchIconButtonClassName } from "../workbench-class-names";
import {
  PanelCloseIcon,
  PanelExpandIcon,
  PanelMinimizeIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../workbench-icons";

type ThreadViewProps = ComponentProps<typeof ThreadView>;

const THREAD_PANEL_REFRESH_INTERVAL_MS = 1500;
const THREAD_PANEL_IDLE_REFRESH_INTERVAL_MS = 5000;
const THREAD_PANEL_HYDRATION: WorkbenchThreadHydrationRequest = { mode: "legacyFull" };
const THREAD_PANEL_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;

interface WorkbenchThreadPanelProps extends Omit<ThreadViewProps, "thread"> {
  fallbackThread?: ThreadPayload | null;
  fallbackThreadSummary?: ThreadSummary | null;
  hasSidebarRestoreInset?: boolean;
  isFocused: boolean;
  isMinimized?: boolean;
  isMinimizedVertical?: boolean;
  onClose?: () => void;
  onCreateDraftThread?: () => ThreadPayload | null;
  onHeaderPointerDragStart?: (event: PointerEvent<HTMLElement>) => void;
  onMinimizeToggle?: () => void;
  onPanelZoomDeltaChange?: (zoomDelta: number) => void;
  panelZoomDelta?: number;
  threadId: string;
}

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

export default function WorkbenchThreadPanel ({
  fallbackThread = null,
  fallbackThreadSummary = null,
  hasSidebarRestoreInset = false,
  isMinimized = false,
  isMinimizedVertical = false,
  onClose,
  onCreateDraftThread,
  onHeaderPointerDragStart,
  onReadThread,
  onMinimizeToggle,
  onPanelZoomDeltaChange,
  onPauseThread,
  onSendMessage,
  onResumeThread,
  onStopThread,
  panelZoomDelta = 0,
  threadId,
  ...threadViewProps
}: WorkbenchThreadPanelProps) {
  const [thread, setThread] = useState<ThreadPayload | null>(fallbackThread?.id === threadId ? fallbackThread : null);
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState(() => Date.now());
  const loadGenerationRef = useRef(0);
  const threadRef = useRef<ThreadPayload | null>(thread);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  useEffect(() => {
    if (threadRef.current?.id === threadId) {
      return;
    }

    setThread(null);
  }, [threadId]);

  useEffect(() => {
    if (threadId !== "new" || threadRef.current?.id === threadId) {
      return;
    }

    const draftThread = onCreateDraftThread?.();
    if (draftThread) {
      setThread(draftThread);
    }
  }, [onCreateDraftThread, threadId]);

  useEffect(() => {
    if (threadId === "new") {
      return;
    }

    let cancelled = false;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;

    async function loadThread() {
      const payload = await onReadThread(threadId, undefined, {
        hydration: THREAD_PANEL_HYDRATION,
      });
      if (!cancelled && loadGenerationRef.current === generation) {
        setThread(payload);
      }
    }

    void loadThread();

    return () => {
      cancelled = true;
    };
  }, [onReadThread, threadId]);

  useEffect(() => {
    if (fallbackThread?.id === threadId) {
      setThread(fallbackThread);
    }
  }, [fallbackThread, threadId]);

  const fallbackSummary = fallbackThreadSummary?.id === threadId ? fallbackThreadSummary : null;
  const threadDisplaySource = thread ?? fallbackSummary;
  const threadActivityTimestampMs = useThreadActivityTimestamp(threadDisplaySource, fallbackSummary);
  const threadLabel = threadDisplaySource ? getThreadTitle(threadDisplaySource) : "";
  const threadStatusLabel = threadActivityTimestampMs
    ? formatThreadRelativeTimestamp(threadActivityTimestampMs / 1000, relativeTimeNowMs)
    : "";

  useEffect(() => {
    if (!threadDisplaySource) {
      return;
    }

    setRelativeTimeNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setRelativeTimeNowMs(Date.now());
    }, THREAD_PANEL_RELATIVE_TIME_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [threadActivityTimestampMs, threadDisplaySource?.id]);

  const readPanelThread = useCallback(async () => {
    const payload = await onReadThread(threadId, thread?.harness, {
      hydration: THREAD_PANEL_HYDRATION,
    });
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onReadThread, thread?.harness, threadId]);

  const handleReadThread = useCallback<ThreadViewProps["onReadThread"]>(async (nextThreadId, harness, options) => {
    const payload = await onReadThread(nextThreadId, harness, options);
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onReadThread, threadId]);

  const handleSendMessage = useCallback<ThreadViewProps["onSendMessage"]>(async (activeThread, input, options) => {
    const payload = await onSendMessage(activeThread, input, options);
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onSendMessage, threadId]);

  const handleStopThread = useCallback<ThreadViewProps["onStopThread"]>(async (activeThread) => {
    const payload = await onStopThread(activeThread);
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onStopThread, threadId]);

  const handlePauseThread = useCallback<ThreadViewProps["onPauseThread"]>(async (activeThread) => {
    const payload = await onPauseThread(activeThread);
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onPauseThread, threadId]);

  const handleResumeThread = useCallback<ThreadViewProps["onResumeThread"]>(async (activeThread) => {
    const payload = await onResumeThread(activeThread);
    if (payload?.id === threadId) {
      setThread(payload);
    }

    return payload;
  }, [onResumeThread, threadId]);

  useEffect(() => {
    if (!thread || thread.isDraft) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void readPanelThread();
    }, isThreadStatusActive(thread.status) ? THREAD_PANEL_REFRESH_INTERVAL_MS : THREAD_PANEL_IDLE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [readPanelThread, thread]);

  if (!thread) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden px-5 md:px-6">
        <ThreadLoadingSkeleton
          contained
          fillAvailableHeight
          showHeader
          statusLabel={threadStatusLabel}
          title={threadLabel}
        />
      </div>
    );
  }

  const effectiveFontSizeRem = Math.min(1.72, Math.max(0.84, Number((threadViewProps.fontSizeRem + panelZoomDelta * 0.08).toFixed(2))));

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      !onHeaderPointerDragStart
      || (
        event.target instanceof HTMLElement
        && event.target.closest("button,a,input,textarea,select,[contenteditable='true']")
      )
    ) {
      return;
    }

    event.preventDefault();
    onHeaderPointerDragStart(event);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header
        className={`sticky top-0 z-10 px-5 py-3 md:px-6${onHeaderPointerDragStart ? " cursor-grab active:cursor-grabbing" : ""}${hasSidebarRestoreInset ? " pl-28 md:pl-28" : ""}${isMinimizedVertical ? " flex h-full items-center justify-center" : ""}`}
        onPointerDown={handleHeaderPointerDown}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_bottom,var(--shell-fade-bg)_calc(100%-var(--spacing)*6),transparent)]"
        />
        <div className={`flex min-w-0 items-start justify-between gap-3${isMinimizedVertical ? " rotate-90 whitespace-nowrap" : ""}`}>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold leading-tight text-text">{threadLabel}</p>
            <p className="mt-1 truncate text-[0.84rem] tracking-[0.02em] text-muted" hidden={isMinimized}>{threadStatusLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onMinimizeToggle ? (
              <button
                type="button"
                title={isMinimized ? "Expand panel" : "Minimize panel"}
                aria-label={isMinimized ? "Expand panel" : "Minimize panel"}
                className={workbenchIconButtonClassName}
                onClick={onMinimizeToggle}
              >
                {isMinimized ? <PanelExpandIcon /> : <PanelMinimizeIcon />}
                <span className="sr-only">{isMinimized ? "Expand panel" : "Minimize panel"}</span>
              </button>
            ) : null}
            <div className="flex items-center gap-1.5" hidden={isMinimized}>
              <button
                type="button"
                title="Decrease thread text size"
                aria-label="Decrease thread text size"
                className={workbenchIconButtonClassName}
                onClick={() => {
                  onPanelZoomDeltaChange?.(panelZoomDelta - 1);
                }}
              >
                <ZoomOutIcon />
                <span className="sr-only">Decrease thread text size</span>
              </button>
              <button
                type="button"
                title="Increase thread text size"
                aria-label="Increase thread text size"
                className={workbenchIconButtonClassName}
                onClick={() => {
                  onPanelZoomDeltaChange?.(panelZoomDelta + 1);
                }}
              >
                <ZoomInIcon />
                <span className="sr-only">Increase thread text size</span>
              </button>
            </div>
            {onClose ? (
              <button
                type="button"
                title="Close panel"
                aria-label="Close panel"
                className={workbenchIconButtonClassName}
                onClick={onClose}
              >
                <PanelCloseIcon />
                <span className="sr-only">Close panel</span>
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 min-w-0 flex-1" hidden={isMinimized}>
        <div className="explorer-scrollbar absolute inset-0 overflow-x-hidden overflow-y-auto px-5 md:px-6" data-thread-scroll-target="true">
          <ThreadView
            {...threadViewProps}
            contained
            fontSizeRem={effectiveFontSizeRem}
            onReadThread={handleReadThread}
            onPauseThread={handlePauseThread}
            onResumeThread={handleResumeThread}
            onSendMessage={handleSendMessage}
            onStopThread={handleStopThread}
            thread={thread}
          />
        </div>
      </div>
    </div>
  );
}
