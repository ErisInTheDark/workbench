/*
 * Exports:
 * - NewEntryIcon: render the create-entry glyph used in the explorer. Keywords: workbench, explorer, icon.
 * - FileVisibilityIcon: render the eye glyph used by the explorer file-visibility toggle. Keywords: workbench, explorer, icon, visibility.
 * - ThreadsList: render the thread list in the workbench sidebar, including the create-thread row. Keywords: workbench, threads, sidebar, create.
 * - ExplorerTree: render the recursive project tree with current, modified, and create-entry state. Keywords: workbench, explorer, tree.
 * - Local helpers: support modified markers, change summaries, and recursive directory state. Keywords: recursion, tree state, helpers.
 */
"use client";

import type { ReactNode } from "react";

import type {
  ChangeSummary,
  ThreadSummary,
  TreeNode,
  WorkbenchControls,
} from "../../lib/types";
import ChevronIcon from "./ChevronIcon";
import { ThreadQuestionBadge, ThreadUnreadBadge } from "./ThreadStatusBadges";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import {
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import { HarnessIcon } from "./workbench-icons";

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

function ThreadListRow ({
  active = false,
  children,
  onClick,
  title,
}: {
  active?: boolean;
  children: ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`${workbenchThreadListButtonClassName}${active ? " text-accent" : " text-muted"}`}
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

function getNodeChangeSummary (node: TreeNode, changes: Record<string, ChangeSummary>): ChangeSummary | null {
  if (node.type === "file") {
    return changes[node.path] ?? null;
  }

  let additions = 0;
  let deletions = 0;

  for (const child of node.children) {
    const summary = getNodeChangeSummary(child, changes);
    if (!summary) {
      continue;
    }

    additions += summary.additions;
    deletions += summary.deletions;
  }

  if (!additions && !deletions) {
    return null;
  }

  return { additions, deletions };
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
  isDraftSelected = false,
  nodes,
  pendingQuestionnaireThreadIds,
  onCreateThread,
  onOpenThread,
}: {
  createThreadLabel?: string;
  currentThreadId: string;
  isDraftSelected?: boolean;
  nodes: ThreadSummary[];
  pendingQuestionnaireThreadIds: ReadonlySet<string>;
  onCreateThread: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const recentThreads = nodes.slice(0, DEFAULT_VISIBLE_THREAD_COUNT);
  const olderThreads = nodes.slice(DEFAULT_VISIBLE_THREAD_COUNT);
  const shouldOpenOlderThreads = olderThreads.some((thread) => thread.id === currentThreadId);

  const renderThreads = (threads: ThreadSummary[]) => (
    <ul className="m-0 p-0">
      {threads.map((thread) => {
        const label = thread.name || thread.preview || thread.id;
        const isCurrent = thread.id === currentThreadId;
        const hasPendingQuestionnaire = !isCurrent && pendingQuestionnaireThreadIds.has(thread.id);
        const unreadBadge = isCurrent ? null : thread.unreadBadge;

        return (
          <li key={thread.id} className="m-0 list-none">
            <ThreadListRow
              active={isCurrent}
              onClick={() => {
                onOpenThread(thread.id);
              }}
              title={label}
            >
              <span className="flex w-full min-w-0 items-center justify-between gap-3">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <HarnessIcon className="size-4 shrink-0" harness={thread.harness} />
                  <span className={`${workbenchThreadListLabelClassName}${isCurrent ? " font-semibold" : ""}`}>{label}</span>
                </span>
                {hasPendingQuestionnaire ? <ThreadQuestionBadge /> : unreadBadge ? <ThreadUnreadBadge badge={unreadBadge} /> : null}
              </span>
            </ThreadListRow>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-1">
      <button
        type="button"
        title={createThreadLabel}
        className={`${workbenchThreadListButtonClassName}${isDraftSelected ? " text-accent" : " text-muted"}`}
        onClick={onCreateThread}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="inline-flex size-4 shrink-0 items-center justify-center text-[1.05em] leading-none">+</span>
          <span className={`${workbenchThreadListLabelClassName}${isDraftSelected ? " font-semibold" : ""}`}>{createThreadLabel}</span>
        </span>
      </button>
      {renderThreads(recentThreads)}
      {olderThreads.length ? (
        <ThreadDisclosure
          className="pt-1"
          contentClassName="mt-1 pl-6"
          open={shouldOpenOlderThreads}
          summary="Older threads"
          summaryClassName="text-[0.78em] leading-[1.5] text-muted"
        >
          {renderThreads(olderThreads)}
        </ThreadDisclosure>
      ) : null}
    </div>
  );
}

function hasModifiedDescendant (node: TreeNode, modifiedPaths: Set<string>): boolean {
  if (node.type === "file") {
    return modifiedPaths.has(node.path);
  }

  return node.children.some((child) => hasModifiedDescendant(child, modifiedPaths));
}

interface ExplorerTreeProps {
  changes: Record<string, ChangeSummary>;
  controls: WorkbenchControls | null;
  currentPath: string;
  expandedDirectories: Set<string>;
  isFileOpenable?: (path: string) => boolean;
  modifiedPaths: Set<string>;
  nested?: boolean;
  nodes: TreeNode[];
  onCreateInDirectory?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

export function ExplorerTree ({
  changes,
  controls,
  currentPath,
  expandedDirectories,
  isFileOpenable,
  modifiedPaths,
  nested = false,
  nodes,
  onCreateInDirectory,
  onOpenFile,
}: ExplorerTreeProps) {
  return (
    <ul
      className={`m-0 p-0${nested ? " ml-4" : ""}`}
      data-role={nested ? "tree-group-nested" : "tree-group-root"}
    >
      {nodes.map((node) => {
        if (node.type === "directory") {
          const changeSummary = getNodeChangeSummary(node, changes);
          const isExpanded = expandedDirectories.has(node.path);
          const isModified = hasModifiedDescendant(node, modifiedPaths);

          return (
            <li
              key={`${node.type}:${node.path}`}
              className="m-0 list-none"
              data-path={node.path}
              data-tree-key={`${node.type}:${node.path}`}
              data-tree-type={node.type}
            >
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
              {isExpanded ? (
                <ExplorerTree
                  changes={changes}
                  controls={controls}
                  currentPath={currentPath}
                  expandedDirectories={expandedDirectories}
                  isFileOpenable={isFileOpenable}
                  modifiedPaths={modifiedPaths}
                  nested
                  nodes={node.children}
                  onCreateInDirectory={onCreateInDirectory}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </li>
          );
        }

        const changeSummary = getNodeChangeSummary(node, changes);
        const isOpenable = isFileOpenable?.(node.path) ?? true;
        const isModified = modifiedPaths.has(node.path);
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
            <div className="flex min-w-0 items-center gap-2">
              <button
                data-role="tree-button"
                type="button"
                aria-disabled={!isOpenable}
                disabled={!isOpenable}
                title={isOpenable ? node.name : disabledTitle}
                className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted disabled:focus-visible:bg-transparent disabled:focus-visible:text-muted md:py-0.5${isCurrent ? " font-semibold text-accent" : ""}`}
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
            </li>
          );
      })}
    </ul>
  );
}
