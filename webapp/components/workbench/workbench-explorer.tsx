/*
 * Exports:
 * - NewEntryIcon: render the create-entry glyph used in the explorer. Keywords: workbench, explorer, icon.
 * - FileVisibilityIcon: render the eye glyph used by the explorer file-visibility toggle. Keywords: workbench, explorer, icon, visibility.
 * - SidebarLoadingSkeleton: render animated placeholder rows for loading sidebar sections. Keywords: sidebar, loading, skeleton.
 * - ThreadsList: render the thread list in the workbench sidebar, including the create-thread row. Keywords: workbench, threads, sidebar, create.
 * - BrowseSessionsList: render active Browse sessions in the workbench sidebar. Keywords: workbench, browse, sessions, sidebar.
 * - ExplorerTree: render the recursive project tree with current, modified, and create-entry state. Keywords: workbench, explorer, tree.
 * - Local helpers: support modified markers, change summaries, and recursive directory state. Keywords: recursion, tree state, helpers.
 */
"use client";

import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";

import type {
  ChangeSummary,
  ThreadSummary,
  TreeNode,
  WorkbenchBrowseSessionSummary,
  WorkbenchControls,
} from "../../lib/types";
import type { WorkbenchDragPayload } from "../../lib/workbench/layout/workbench-drag";
import ChevronIcon from "./ChevronIcon";
import ContextMenuCapability from "./ContextMenuCapability";
import { ThreadQuestionBadge, ThreadUnreadBadge } from "./ThreadStatusBadges";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuProvider";
import {
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import { BrowserSessionIcon, HarnessIcon, PinIcon, SparkleIcon } from "./workbench-icons";

const DEFAULT_VISIBLE_THREAD_COUNT = 5;

export function NewEntryIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M6 2.75H11.75L15.5 6.5V16.25C15.5 16.94 14.94 17.5 14.25 17.5H6C5.31 17.5 4.75 16.94 4.75 16.25V4C4.75 3.31 5.31 2.75 6 2.75Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.75 2.75V6.5H15.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.125 9V14M7.625 11.5H12.625" strokeLinecap="round" />
    </svg>
  );
}

export function FileVisibilityIcon ({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M2.75 10C4.41 6.78 6.98 5.17 10 5.17C13.02 5.17 15.59 6.78 17.25 10C15.59 13.22 13.02 14.83 10 14.83C6.98 14.83 4.41 13.22 2.75 10Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.2" />
      {visible ? null : <path d="M4.1 4.1 15.9 15.9" strokeLinecap="round" />}
    </svg>
  );
}

export function SidebarLoadingSkeleton ({
  ariaLabel,
  rows,
}: {
  ariaLabel: string;
  rows: number;
}) {
  return (
    <div aria-label={ariaLabel} aria-live="polite" role="status" className="space-y-1 py-1 pr-2 md:pr-4.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 min-w-0 items-center gap-2 px-2">
          <span className="size-4 shrink-0 rounded-full workbench-skeleton" aria-hidden="true" />
          <span
            className="h-3.5 rounded-full workbench-skeleton"
            style={{ width: `${Math.max(42, 86 - index * 7)}%` }}
            aria-hidden="true"
          />
        </div>
      ))}
    </div>
  );
}

function ThreadListRow ({
  active = false,
  children,
  onClick,
  title,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  title: string;
}) {
  const className = `${workbenchThreadListButtonClassName}${active ? " text-accent" : " text-muted"}`;
  if (!onClick) {
    return (
      <div
        title={title}
        className={className}
      >
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      title={title}
      className={className}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ExplorerModifiedDot ({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--attention)]"
      aria-hidden="true"
    />
  );
}

function ExplorerFileSpacer () {
  return (
    <span
      data-role="tree-spacer"
      className="shrink-0"
      style={{ width: "1.1rem", height: "1.1rem" }}
      aria-hidden="true"
    />
  );
}

function ExplorerChangeSummary ({ summary }: { summary: ChangeSummary | null }) {
  if (!summary || (!summary.additions && !summary.deletions)) {
    return null;
  }

  return (
    <span data-role="tree-change" className="inline-flex shrink-0 items-center gap-1.5 text-[0.8rem]">
      {summary.additions ? (
        <span className="text-[var(--explorer-change-add)]">
          +{summary.additions}
        </span>
      ) : null}
      {summary.deletions ? (
        <span className="text-[var(--explorer-change-del)]">
          -{summary.deletions}
        </span>
      ) : null}
    </span>
  );
}

export function ThreadsList ({
  createThreadLabel = "Create new thread",
  currentThreadId,
  getThreadDragPayload,
  getThreadContextMenu,
  isDraftSelected = false,
  nodes,
  pendingQuestionnaireThreadIds,
  pinnedNodes = [],
  onCreateThread,
  onCreateThreadPointerDragStart,
  onThreadPointerDragStart,
  onOpenThread,
}: {
  createThreadLabel?: string;
  getThreadContextMenu?: (thread: ThreadSummary) => WorkbenchContextMenuDefinition | null;
  currentThreadId: string;
  getThreadDragPayload?: (thread: ThreadSummary) => WorkbenchDragPayload | null;
  isDraftSelected?: boolean;
  nodes: ThreadSummary[];
  pendingQuestionnaireThreadIds: ReadonlySet<string>;
  pinnedNodes?: ThreadSummary[];
  onCreateThread: () => void;
  onCreateThreadPointerDragStart?: (event: PointerEvent<HTMLButtonElement>) => void;
  onThreadPointerDragStart?: (event: PointerEvent<HTMLElement>, thread: ThreadSummary) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const recentThreads = nodes.slice(0, DEFAULT_VISIBLE_THREAD_COUNT);
  const olderThreads = nodes.slice(DEFAULT_VISIBLE_THREAD_COUNT);
  const shouldOpenOlderThreads = olderThreads.some((thread) => thread.id === currentThreadId);
  const [isOlderThreadsOpen, setIsOlderThreadsOpen] = useState(shouldOpenOlderThreads);

  useEffect(() => {
    if (shouldOpenOlderThreads) {
      setIsOlderThreadsOpen(true);
    }
  }, [shouldOpenOlderThreads]);

  const renderThreads = (threads: ThreadSummary[], options: { pinned?: boolean } = {}) => (
    <ul className="m-0 p-0">
      {threads.map((thread) => {
        const label = thread.name || thread.preview || thread.id;
        const isCurrent = thread.id === currentThreadId;
        const hasPendingQuestionnaire = !isCurrent && pendingQuestionnaireThreadIds.has(thread.id);
        const unreadBadge = isCurrent ? null : thread.unreadBadge;

        return (
          <li key={`${thread.harness}:${thread.id}`} className="m-0 list-none">
            <ContextMenuCapability menu={getThreadContextMenu?.(thread) ?? null}>
              <ThreadListRow
                active={isCurrent}
                onClick={() => {
                  onOpenThread(thread.id);
                }}
                title={label}
              >
                <span
                  className="flex w-full min-w-0 items-center justify-between gap-3"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onThreadPointerDragStart?.(event, thread);
                  }}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    {options.pinned ? <PinIcon className="size-4 shrink-0" /> : <HarnessIcon className="size-4 shrink-0" harness={thread.harness} />}
                    <span className={`${workbenchThreadListLabelClassName}${isCurrent ? " font-semibold" : ""}`}>{label}</span>
                  </span>
                  {hasPendingQuestionnaire ? <ThreadQuestionBadge /> : unreadBadge ? <ThreadUnreadBadge badge={unreadBadge} /> : null}
                </span>
              </ThreadListRow>
            </ContextMenuCapability>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-1">
      {pinnedNodes.length ? renderThreads(pinnedNodes, { pinned: true }) : null}
      <button
        type="button"
        title={createThreadLabel}
        className={`${workbenchThreadListButtonClassName}${isDraftSelected ? " text-accent" : " text-muted"}`}
        onClick={onCreateThread}
        onPointerDown={(event) => {
          event.stopPropagation();
          onCreateThreadPointerDragStart?.(event);
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <SparkleIcon className="size-4 shrink-0" />
          <span className={`${workbenchThreadListLabelClassName}${isDraftSelected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </button>
      {renderThreads(recentThreads)}
      {olderThreads.length ? (
        <ThreadDisclosure
          className="pt-1"
          contentClassName="mt-1 pl-6"
          open={isOlderThreadsOpen}
          onToggle={(event) => {
            setIsOlderThreadsOpen(event.currentTarget.open);
          }}
          summary="Older threads"
          summaryClassName="text-[0.78em] leading-[1.5] text-muted"
        >
          {renderThreads(olderThreads)}
        </ThreadDisclosure>
      ) : null}
    </div>
  );
}

export function BrowseSessionsList ({
  getSessionContextMenu,
  isLoading,
  sessions,
}: {
  getSessionContextMenu?: (session: WorkbenchBrowseSessionSummary) => WorkbenchContextMenuDefinition | null;
  isLoading: boolean;
  sessions: WorkbenchBrowseSessionSummary[];
}) {
  if (isLoading && !sessions.length) {
    return <SidebarLoadingSkeleton ariaLabel="Loading Browse sessions" rows={3} />;
  }

  if (!sessions.length) {
    return null;
  }

  return (
    <ul className="m-0 space-y-1 p-0">
      {sessions.map((session) => {
        const detail = formatBrowseSessionDetail(session);
        const title = `${session.name}${detail ? ` — ${detail}` : ""}`;
        const isProblemState = session.state === "orphan" || session.state === "stale" || session.state === "unknown";

        return (
          <li key={session.name} className="m-0 list-none">
            <ContextMenuCapability menu={getSessionContextMenu?.(session) ?? null}>
              <ThreadListRow
                active={isProblemState}
                title={title}
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <BrowserSessionIcon className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className={`${workbenchThreadListLabelClassName}${isProblemState ? " font-semibold" : ""}`}>{session.name}</span>
                      {detail ? <span className="block truncate text-[0.75rem] leading-4 text-muted">{detail}</span> : null}
                    </span>
                  </span>
                </span>
              </ThreadListRow>
            </ContextMenuCapability>
          </li>
        );
      })}
    </ul>
  );
}

function formatBrowseSessionDetail(session: WorkbenchBrowseSessionSummary) {
  const parts = [
    session.mode,
    session.threadId ? `thread ${session.threadId.slice(0, 8)}` : null,
    session.state,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

interface ExplorerTreeDerivedState {
  changeSummariesByPath: ReadonlyMap<string, ChangeSummary>;
  modifiedPathsWithDescendants: ReadonlySet<string>;
}

function buildExplorerTreeDerivedState (
  nodes: TreeNode[],
  changes: Record<string, ChangeSummary>,
  modifiedPaths: Set<string>,
): ExplorerTreeDerivedState {
  const changeSummariesByPath = new Map<string, ChangeSummary>();
  const modifiedPathsWithDescendants = new Set<string>();

  const visit = (node: TreeNode): ChangeSummary | null => {
    if (node.type === "file") {
      const summary = changes[node.path] ?? null;
      if (summary) {
        changeSummariesByPath.set(node.path, summary);
      }
      if (modifiedPaths.has(node.path)) {
        modifiedPathsWithDescendants.add(node.path);
      }
      return summary;
    }

    let additions = 0;
    let deletions = 0;
    let isModified = modifiedPaths.has(node.path);

    for (const child of node.children) {
      const summary = visit(child);
      if (summary) {
        additions += summary.additions;
        deletions += summary.deletions;
      }
      if (modifiedPathsWithDescendants.has(child.path)) {
        isModified = true;
      }
    }

    if (isModified) {
      modifiedPathsWithDescendants.add(node.path);
    }

    if (!additions && !deletions) {
      return null;
    }

    const summary = { additions, deletions };
    changeSummariesByPath.set(node.path, summary);
    return summary;
  };

  for (const node of nodes) {
    visit(node);
  }

  return {
    changeSummariesByPath,
    modifiedPathsWithDescendants,
  };
}

interface ExplorerTreeProps {
  changes: Record<string, ChangeSummary>;
  controls: WorkbenchControls | null;
  currentPath: string;
  expandedDirectories: Set<string>;
  isFileOpenable?: (path: string) => boolean;
  getFileDragPayload?: (path: string) => WorkbenchDragPayload | null;
  getNodeContextMenu?: (node: TreeNode) => WorkbenchContextMenuDefinition | null;
  derivedState?: ExplorerTreeDerivedState;
  modifiedPaths: Set<string>;
  nested?: boolean;
  nodes: TreeNode[];
  onCreateInDirectory?: (path: string) => void;
  onFilePointerDragStart?: (event: PointerEvent<HTMLElement>, path: string) => void;
  onOpenFile?: (path: string) => void;
}

export function ExplorerTree ({
  changes,
  controls,
  currentPath,
  derivedState,
  expandedDirectories,
  isFileOpenable,
  getFileDragPayload,
  getNodeContextMenu,
  modifiedPaths,
  nested = false,
  nodes,
  onCreateInDirectory,
  onFilePointerDragStart,
  onOpenFile,
}: ExplorerTreeProps) {
  const treeDerivedState = useMemo(() => (
    derivedState ?? buildExplorerTreeDerivedState(nodes, changes, modifiedPaths)
  ), [changes, derivedState, modifiedPaths, nodes]);

  return (
    <ul
      className={`m-0 p-0${nested ? " ml-4" : ""}`}
      data-role={nested ? "tree-group-nested" : "tree-group-root"}
    >
      {nodes.map((node) => {
        if (node.type === "directory") {
          const changeSummary = treeDerivedState.changeSummariesByPath.get(node.path) ?? null;
          const isExpanded = expandedDirectories.has(node.path);
          const isModified = treeDerivedState.modifiedPathsWithDescendants.has(node.path);

          return (
            <li
              key={`${node.type}:${node.path}`}
              className="m-0 list-none"
              data-path={node.path}
              data-tree-key={`${node.type}:${node.path}`}
              data-tree-type={node.type}
            >
              <ContextMenuCapability menu={getNodeContextMenu?.(node) ?? null}>
                <div className="group/entry-row flex min-w-0 items-center justify-between gap-2">
                  <button
                  data-role="tree-button"
                  type="button"
                  className="inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-0.5"
                  onClick={() => {
                    controls?.toggleDirectory(node.path);
                  }}
                >
                  <ChevronIcon
                    data-role="tree-chevron"
                    className="mt-0.5 transition-transform"
                    style={{
                      width: "1.1rem",
                      height: "1.1rem",
                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    }}
                  />
                  <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                  <ExplorerModifiedDot hidden={!isModified} />
                  <ExplorerChangeSummary summary={changeSummary} />
                  </button>
                  <button
                  type="button"
                  aria-label={`Create in ${node.name}`}
                  title={`Create in ${node.name}`}
                  className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}`}
                  onClick={() => {
                    onCreateInDirectory?.(node.path);
                  }}
                >
                  <NewEntryIcon />
                  <span className="sr-only">{`Create in ${node.name}`}</span>
                  </button>
                </div>
              </ContextMenuCapability>
              {isExpanded ? (
                <ExplorerTree
                  changes={changes}
                  controls={controls}
                  currentPath={currentPath}
                  derivedState={treeDerivedState}
                  expandedDirectories={expandedDirectories}
                  getFileDragPayload={getFileDragPayload}
                  getNodeContextMenu={getNodeContextMenu}
                  isFileOpenable={isFileOpenable}
                  modifiedPaths={modifiedPaths}
                  nested
                  nodes={node.children}
                  onCreateInDirectory={onCreateInDirectory}
                  onFilePointerDragStart={onFilePointerDragStart}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </li>
          );
        }

        const changeSummary = treeDerivedState.changeSummariesByPath.get(node.path) ?? null;
        const isOpenable = isFileOpenable?.(node.path) ?? true;
        const isModified = treeDerivedState.modifiedPathsWithDescendants.has(node.path);
        const isCurrent = node.path === currentPath;
        const disabledTitle = `${node.name} can't be opened in the workbench`;

        return (
          <li
            key={`${node.type}:${node.path}`}
            className="m-0 list-none"
            data-path={node.path}
            data-tree-key={`${node.type}:${node.path}`}
            data-tree-type={node.type}
          >
            <ContextMenuCapability menu={getNodeContextMenu?.(node) ?? null}>
              <div className="flex min-w-0 items-center gap-2">
                <button
                data-role="tree-button"
                type="button"
                aria-disabled={!isOpenable}
                disabled={!isOpenable}
                title={isOpenable ? node.name : disabledTitle}
                className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted disabled:focus-visible:bg-transparent disabled:focus-visible:text-muted md:py-0.5${isCurrent ? " font-semibold text-accent" : ""}`}
                onPointerDown={(event) => {
                  if (!isOpenable) {
                    return;
                  }

                  event.stopPropagation();
                  onFilePointerDragStart?.(event, node.path);
                }}
                onClick={() => {
                  if (!isOpenable) {
                    return;
                  }

                  onOpenFile?.(node.path);
                }}
                >
                  <ExplorerFileSpacer />
                  <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                  <ExplorerModifiedDot hidden={!isModified} />
                  <ExplorerChangeSummary summary={changeSummary} />
                </button>
              </div>
            </ContextMenuCapability>
            </li>
          );
      })}
    </ul>
  );
}
