/*
 * Exports:
 * - default WorkbenchThreadPanel: hydrate through an identity-bound controller and render one thread target inside a split panel.
 */
"use client";

import { useEffect, useRef, useState, type ComponentProps, type PointerEvent } from "react";

import type { ThreadPayload, ThreadSummary } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import ThreadScrollViewport from "../thread-view/ThreadScrollViewport";
import ThreadView from "../thread-view/ThreadView";
import { useWorkbenchThread } from "../use-workbench-thread";
import { useWorkbenchClientController } from "../workbench-client-context";
import WorkbenchDaemonClientContext, { WorkbenchDaemonAssetOriginContext, useWorkbenchDaemonAssetOrigin, useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import WorkbenchWorkingTreeProvider from "../git/WorkbenchWorkingTreeProvider";
import WorkbenchComposerProfileProvider from "../WorkbenchComposerProfileProvider";
import type WorkbenchComposerProfileController from "../../../workbench/state/WorkbenchComposerProfileController";
import resolveThreadActivityTimestampMs from "../thread-view/thread-activity-timestamp";
import { formatThreadRelativeTimestamp, getThreadTitle } from "../thread-view/thread-view-formatters";
import WorkbenchIconButton from "../WorkbenchIconButton";
import WorkbenchZoomButton from "../WorkbenchZoomButton";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE } from "../../../workbench/state/workbench-settings";
import {
  PanelCloseIcon,
  PanelExpandIcon,
  PanelMinimizeIcon,
} from "../workbench-icons";

type ThreadViewProps = ComponentProps<typeof ThreadView>;

const THREAD_PANEL_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;

interface WorkbenchThreadPanelProps extends Omit<ThreadViewProps, "scrollViewportRef" | "thread"> {
  fallbackThreadSummary?: ThreadSummary | null;
  hasSidebarRestoreInset?: boolean;
  isFocused: boolean;
  isMinimized?: boolean;
  isMinimizedVertical?: boolean;
  location?: ProjectLocationReference | null;
  onClose?: () => void;
  onCreateDraftThread?: () => ThreadPayload | null;
  onHeaderPointerDragStart?: (event: PointerEvent<HTMLElement>) => void;
  onMinimizeToggle?: () => void;
  onPanelZoomDeltaChange?: (zoomDelta: number) => void;
  panelZoomDelta?: number;
  profileController: WorkbenchComposerProfileController;
  thread: ThreadPayload | null;
  threadId: string;
}

export default function WorkbenchThreadPanel ({
  fallbackThreadSummary = null,
  hasSidebarRestoreInset = false,
  isMinimized = false,
  isMinimizedVertical = false,
  location = null,
  onClose,
  onCreateDraftThread,
  onHeaderPointerDragStart,
  onMinimizeToggle,
  onPanelZoomDeltaChange,
  panelZoomDelta = 0,
  profileController,
  thread,
  threadId,
  ...threadViewProps
}: WorkbenchThreadPanelProps) {
  const client = useWorkbenchClientController();
  const outerDaemon = useWorkbenchDaemonClient();
  const outerAssetOrigin = useWorkbenchDaemonAssetOrigin();
  const threadContext = threadViewProps.threadTarget?.kind === "provider"
    || threadViewProps.threadTarget?.kind === "subagent"
    ? client.mounted?.threadContextFor(threadId) : null;
  const launchContext = location ? client.mounted?.launchContextFor(location) : null;
  const panelContext = threadContext ?? launchContext;
  const ownerMetadata = threadViewProps.threadTarget?.kind === "provider"
    || threadViewProps.threadTarget?.kind === "subagent"
    ? client.mounted?.threadOwnerFor(threadId) : null;
  const threadController = useWorkbenchThread(threadViewProps.projectId, threadViewProps.threadTarget, undefined, threadViewProps.routeOwned ? "route" : "summary");
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState(() => Date.now());
  const [zoomPreview, setZoomPreview] = useState<number | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const initializedNewRef = useRef(false);

  useEffect(() => {
    if (threadId !== "new") {
      initializedNewRef.current = false;
      return;
    }
    if (initializedNewRef.current || thread?.id === threadId) return;
    initializedNewRef.current = true;
    onCreateDraftThread?.();
  }, [onCreateDraftThread, thread?.id, threadId]);

  const fallbackSummary = fallbackThreadSummary?.id === threadId ? fallbackThreadSummary : null;
  const threadDisplaySource = threadController.state.document ?? thread ?? fallbackSummary;
  const threadActivityTimestampMs = resolveThreadActivityTimestampMs(threadDisplaySource, fallbackSummary);
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

  const effectiveFontSizeRem = Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Number((threadViewProps.fontSizeRem + (zoomPreview ?? panelZoomDelta) * 0.08).toFixed(2))));

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
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-thread-daemon-id={ownerMetadata?.daemonId ?? launchContext?.daemonId}
      data-thread-project-id={ownerMetadata?.projectId ?? launchContext?.project.id}>
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
            <p className="mt-1 truncate text-[0.84rem] tracking-[0.02em] text-fg/muted" hidden={isMinimized}>{threadStatusLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onMinimizeToggle ? (
              <WorkbenchIconButton
                type="button"
                title={isMinimized ? "Expand panel" : "Minimize panel"}
                label={isMinimized ? "Expand panel" : "Minimize panel"}
                display="hover-border"
                onClick={onMinimizeToggle}
              >
                {isMinimized ? <PanelExpandIcon size={20} /> : <PanelMinimizeIcon size={20} />}
                <span className="sr-only">{isMinimized ? "Expand panel" : "Minimize panel"}</span>
              </WorkbenchIconButton>
            ) : null}
            <div className="flex items-center gap-1.5" hidden={isMinimized}>
              <WorkbenchZoomButton
                label="Thread text size"
                disabled={isMinimized || !onPanelZoomDeltaChange}
                min={Math.floor(Number(((MIN_EDITOR_FONT_SIZE - threadViewProps.fontSizeRem) / 0.08).toFixed(6)))}
                max={Math.ceil(Number(((MAX_EDITOR_FONT_SIZE - threadViewProps.fontSizeRem) / 0.08).toFixed(6)))}
                step={1}
                value={panelZoomDelta}
                onPreview={setZoomPreview}
                format={delta => `${Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, threadViewProps.fontSizeRem + delta * 0.08)).toFixed(2)}rem`}
                onChange={(value) => onPanelZoomDeltaChange?.(value)}
              />
            </div>
            {onClose ? (
              <WorkbenchIconButton
                type="button"
                title="Close panel"
                label="Close panel"
                display="hover-border"
                onClick={onClose}
              >
                <PanelCloseIcon size={16} />
                <span className="sr-only">Close panel</span>
              </WorkbenchIconButton>
            ) : null}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" hidden={isMinimized}>
        <ThreadScrollViewport
          ref={scrollViewportRef}
          className="absolute inset-0 px-5 md:px-6"
          contentClassName="flex flex-col"
          resetKey={`${thread?.harness ?? "thread"}:${threadViewProps.selectedThreadId ?? thread?.id ?? threadId}`}
        >
          {(threadViewProps.threadTarget?.kind === "provider"
            || threadViewProps.threadTarget?.kind === "subagent"
            || location) && !panelContext
            ? <p className="py-6 text-sm text-fg/muted">
              Thread owner unavailable.
              {ownerMetadata ? ` ${ownerMetadata.hostname} \u00b7 ${ownerMetadata.rootPath}` : null}
            </p>
            : <WorkbenchDaemonClientContext.Provider value={panelContext?.daemon ?? outerDaemon}>
            <WorkbenchDaemonAssetOriginContext.Provider value={{
              origin: panelContext ? panelContext.assetOrigin : outerAssetOrigin ?? null,
            }}>
              <WorkbenchWorkingTreeProvider
                projectId={panelContext?.project.id ?? threadViewProps.projectId}
                sourceDaemon={panelContext?.daemon ?? outerDaemon}
                sourceDaemonId={panelContext?.daemonId ?? null}
              >
              <WorkbenchComposerProfileProvider controller={profileController}>
              <ThreadView
                {...threadViewProps}
                projectId={panelContext?.project.id ?? threadViewProps.projectId}
                projectRootPath={panelContext?.project.rootPath ?? threadViewProps.projectRootPath}
                projectRoots={panelContext?.project.roots ?? threadViewProps.projectRoots}
                threadOwnerContent={ownerMetadata
                  ? <span className="truncate font-mono text-fg/muted">
                    {ownerMetadata.hostname} {" \u00b7 "} {ownerMetadata.rootPath}
                  </span> : threadViewProps.threadOwnerContent}
                contained
                fontSizeRem={effectiveFontSizeRem}
                scrollViewportRef={scrollViewportRef}
                thread={thread}
              />
              </WorkbenchComposerProfileProvider>
              </WorkbenchWorkingTreeProvider>
            </WorkbenchDaemonAssetOriginContext.Provider>
          </WorkbenchDaemonClientContext.Provider>}
        </ThreadScrollViewport>
      </div>
    </div>
  );
}
