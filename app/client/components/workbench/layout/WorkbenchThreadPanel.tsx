/*
 * Exports:
 * - default WorkbenchThreadPanel: hydrate through an identity-bound controller and render one thread target inside a split panel.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent } from "react";

import type { ThreadPayload } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import ThreadScrollViewport from "../thread-view/ThreadScrollViewport";
import ThreadView from "../thread-view/ThreadView";
import { useWorkbenchDrag } from "../drag/workbench-drag-context";
import type { WorkbenchMainPanelDragPayload } from "../../../workbench/layout/workbench-drag";
import { useThread } from "../use-thread";
import { useThreads } from "../use-threads";
import { normalizeWorkbenchTimestampMs } from "workbench-shared/workbench/thread/thread-state";
import { useWorkbenchClientController } from "../workbench-client-context";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import WorkbenchThreadDaemonScope from "../WorkbenchThreadDaemonScope";
import WorkbenchWorkingTreeProvider from "../git/WorkbenchWorkingTreeProvider";
import { FileScopeContext } from "../../../workbench/file/use-file";
import WorkbenchComposerProfileProvider from "../WorkbenchComposerProfileProvider";
import type WorkbenchComposerProfileController from "../../../workbench/state/WorkbenchComposerProfileController";
import resolveThreadActivityTimestampMs from "../thread-view/thread-activity-timestamp";
import { getThreadTitle } from "../thread-view/thread-view-formatters";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";
import IconButton from "../../ui/IconButton";
import WorkbenchZoomButton from "../WorkbenchZoomButton";
import WorkbenchThreadOwnerLabel from "../WorkbenchThreadOwnerLabel";
import { MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE } from "../../../workbench/state/workbench-settings";
import { useSettings } from "../use-settings";
import {
  PanelCloseIcon,
  PanelExpandIcon,
  PanelMinimizeIcon,
} from "../workbench-icons";

type ThreadViewProps = ComponentProps<typeof ThreadView>;


interface WorkbenchThreadPanelProps extends Omit<ThreadViewProps, "scrollViewportRef" | "thread" | "fontSizeRem"> {
  fontSizePreview?: number | null;
  sidebarToggleInset?: "collapsed" | "expanded";
  isFocused: boolean;
  isMinimized?: boolean;
  isMinimizedVertical?: boolean;
  location?: ProjectLocationReference | null;
  onClose?: () => void;
  onCreateDraftThread?: () => ThreadPayload | null;
  headerDrag?: WorkbenchMainPanelDragPayload;
  onMinimizeToggle?: () => void;
  onPanelZoomDeltaChange?: (zoomDelta: number) => void;
  panelZoomDelta?: number;
  profileController: WorkbenchComposerProfileController;
  thread: ThreadPayload | null;
  threadId: string;
}

export default function WorkbenchThreadPanel ({
  fontSizePreview,
  sidebarToggleInset,
  isFocused,
  isMinimized = false,
  isMinimizedVertical = false,
  location = null,
  onClose,
  onCreateDraftThread,
  headerDrag,
  onMinimizeToggle,
  onPanelZoomDeltaChange,
  panelZoomDelta = 0,
  profileController,
  thread,
  threadId,
  ...threadViewProps
}: WorkbenchThreadPanelProps) {
  const client = useWorkbenchClientController();
  const settings = useSettings.forThread(threadViewProps.threadTarget?.kind === "new" && thread?.isDraft
    ? { kind: "draft", draftId: thread.id } : threadViewProps.threadTarget ?? null, location);
  const baseFontSize = fontSizePreview ?? settings.get("editorFontSize");
  const outerDaemon = useWorkbenchDaemonClient();
  const isExistingThread = threadViewProps.threadTarget?.kind === "provider"
    || threadViewProps.threadTarget?.kind === "subagent";
  const threadContext = isExistingThread ? client.mounted?.threadContextFor(threadId) : null;
  const launchContext = location ? client.mounted?.launchContextFor(location) : null;
  const panelContext = threadContext ?? launchContext;
  const fileScope = useMemo(() => ({
    daemon: panelContext?.daemon ?? outerDaemon,
    daemonId: panelContext?.daemonId ?? null,
    projectId: panelContext?.project.id ?? threadViewProps.projectId,
  }), [outerDaemon, panelContext?.daemon, panelContext?.daemonId, panelContext?.project.id,
    threadViewProps.projectId]);
  const ownerMetadata = isExistingThread ? client.mounted?.threadOwnerFor(threadId)
    : location ? client.mounted?.locationOwnerFor(location) : null;
  const panelThread = useThread(threadViewProps.projectId, threadViewProps.threadTarget, threadViewProps.routeOwned ? "route" : "summary");
  const runtimeThreads = useThreads().threads;
  const [zoomPreview, setZoomPreview] = useState<number | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const beginDrag = useWorkbenchDrag.mainPanel();
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

  const fallbackSummary = runtimeThreads.find(summary => summary.id === threadId) ?? null;
  const threadDisplaySource = panelThread.draftDocument ?? thread ?? fallbackSummary;
  // Observed feeds have no document: the thread entry carries the title and activity.
  const threadActivityTimestampMs = threadDisplaySource
    ? resolveThreadActivityTimestampMs(threadDisplaySource, fallbackSummary)
    : panelThread.entry ? normalizeWorkbenchTimestampMs(panelThread.entry.activityAt) : null;
  const threadLabel = threadDisplaySource ? getThreadTitle(threadDisplaySource) : panelThread.entry?.title ?? "";
  const threadStatusLabel = threadActivityTimestampMs
    ? <WorkbenchRelativeTime label="Last activity" timestampMs={threadActivityTimestampMs} />
    : null;

  const effectiveFontSizeRem = Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Number((baseFontSize + (zoomPreview ?? panelZoomDelta) * 0.08).toFixed(2))));
  const rootViewKey = threadViewProps.viewInstanceKey ?? threadId;
  const selectedViewKey = threadViewProps.selectedThreadId && threadViewProps.selectedThreadId !== threadId
    ? threadViewProps.selectedThreadId : rootViewKey;

  function handleHeaderPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      !headerDrag
      || (
        event.target instanceof HTMLElement
        && event.target.closest("button,a,input,textarea,select,[contenteditable='true']")
      )
    ) {
      return;
    }

    event.preventDefault();
    beginDrag(event, headerDrag);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-thread-daemon-id={ownerMetadata?.daemonId ?? launchContext?.daemonId}
      data-thread-project-id={ownerMetadata?.projectId ?? launchContext?.project.id}>
      <header
        className={`sticky top-0 z-10 py-3 ${sidebarToggleInset === "collapsed" ? "pl-28 pr-5 md:pl-28 md:pr-6" : sidebarToggleInset === "expanded" ? "pl-19 pr-5 md:pl-19 md:pr-6" : "px-5 md:px-6"}${headerDrag ? " cursor-grab active:cursor-grabbing" : ""}${isMinimizedVertical ? " flex h-full items-center justify-center" : ""}`}
        onPointerDown={handleHeaderPointerDown}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to bottom, var(--app-bg-solid) calc(100% - var(--spacing) * 6), transparent)]"
        />
        <div className={`flex min-w-0 items-start justify-between gap-3${isMinimizedVertical ? " rotate-90 whitespace-nowrap" : ""}`}>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold leading-tight text-text">{threadLabel}</p>
            <p className="mt-1 truncate text-[0.84rem] tracking-[0.02em] text-fg/muted" hidden={isMinimized}>{threadStatusLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onMinimizeToggle ? (
              <IconButton
                type="button"
                title={isMinimized ? "Expand panel" : "Minimize panel"}
                label={isMinimized ? "Expand panel" : "Minimize panel"}
                display="hover-border"
                onClick={onMinimizeToggle}
              >
                {isMinimized ? <PanelExpandIcon size={20} /> : <PanelMinimizeIcon size={20} />}
                <span className="sr-only">{isMinimized ? "Expand panel" : "Minimize panel"}</span>
              </IconButton>
            ) : null}
            <div className="flex items-center gap-1.5" hidden={isMinimized}>
              <WorkbenchZoomButton
                label="Thread text size"
                disabled={isMinimized || !onPanelZoomDeltaChange}
                min={Math.floor(Number(((MIN_EDITOR_FONT_SIZE - baseFontSize) / 0.08).toFixed(6)))}
                max={Math.ceil(Number(((MAX_EDITOR_FONT_SIZE - baseFontSize) / 0.08).toFixed(6)))}
                step={1}
                value={panelZoomDelta}
                onPreview={setZoomPreview}
                format={delta => `${Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, baseFontSize + delta * 0.08)).toFixed(2)}rem`}
                onChange={(value) => onPanelZoomDeltaChange?.(value)}
              />
            </div>
            {onClose ? (
              <IconButton
                type="button"
                title="Close panel"
                label="Close panel"
                display="hover-border"
                onClick={onClose}
              >
                <PanelCloseIcon size={16} />
                <span className="sr-only">Close panel</span>
              </IconButton>
            ) : null}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" hidden={isMinimized}>
        <ThreadScrollViewport
          ref={scrollViewportRef}
          className="absolute inset-0 px-5 md:px-6"
          contentClassName="flex flex-col"
          resetKey={`${rootViewKey}:${selectedViewKey}`}
        >
          {(isExistingThread || location) && !panelContext
            ? <p className="py-6 text-sm text-fg/muted">
              Thread owner unavailable.
              {ownerMetadata ? ` ${ownerMetadata.displayPath}` : null}
            </p>
            : <WorkbenchThreadDaemonScope context={panelContext}>
              <FileScopeContext.Provider value={fileScope}>
              <WorkbenchWorkingTreeProvider
                projectId={panelContext?.project.id ?? threadViewProps.projectId}
                sourceDaemon={panelContext?.daemon ?? outerDaemon}
                sourceDaemonId={panelContext?.daemonId ?? null}
              >
              <WorkbenchComposerProfileProvider controller={profileController}>
              <ThreadView
                {...threadViewProps}
                isFocused={isFocused && !isMinimized}
                projectId={panelContext?.project.id ?? threadViewProps.projectId}
                projectRootPath={panelContext?.project.rootPath ?? threadViewProps.projectRootPath}
                projectRoots={panelContext?.project.roots ?? threadViewProps.projectRoots}
                threadOwnerContent={ownerMetadata
                  ? <WorkbenchThreadOwnerLabel owner={ownerMetadata} project={panelContext?.project} />
                  : threadViewProps.threadOwnerContent}
                contained
                fontSizeRem={effectiveFontSizeRem}
                settingsLocation={location}
                scrollViewportRef={scrollViewportRef}
                thread={thread}
              />
              </WorkbenchComposerProfileProvider>
              </WorkbenchWorkingTreeProvider>
              </FileScopeContext.Provider>
          </WorkbenchThreadDaemonScope>}
        </ThreadScrollViewport>
      </div>
    </div>
  );
}
