/*
 * Exports:
 * - NewEntryIcon: render the create-entry glyph used in the explorer. Keywords: workbench, explorer, icon.
 * - ThreadsList: render the thread list in the workbench sidebar. Keywords: workbench, threads, sidebar.
 * - ExplorerTree: render the recursive project tree with current, modified, and create-entry state. Keywords: workbench, explorer, tree.
 * - Local helpers: support modified markers, change summaries, and recursive directory state. Keywords: recursion, tree state, helpers.
 */
"use client";

import type {
  ChangeSummary,
  ThreadSummary,
  TreeNode,
  WorkbenchControls,
} from "../../lib/types";
import ChevronIcon from "./ChevronIcon";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import {
  workbenchIconButtonClassName,
  workbenchNewEntryButtonClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";

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

function ExplorerModifiedDot ({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#d0ad12] dark:bg-[#ffd84d]"
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

export function ThreadsList ({
  currentThreadId,
  nodes,
  onOpenThread,
}: {
  currentThreadId: string;
  nodes: ThreadSummary[];
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

        return (
          <li key={thread.id} className="m-0 list-none">
            <button
              type="button"
              title={label}
              className={`${workbenchThreadListButtonClassName}${isCurrent ? " text-accent" : " text-muted"}`}
              onClick={() => {
                onOpenThread(thread.id);
              }}
            >
              <span className={`${workbenchThreadListLabelClassName}${isCurrent ? " font-semibold" : ""}`}>{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-1">
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

function describeChange (filePath: string, changes: Record<string, ChangeSummary>) {
  const entry = changes[filePath];
  if (!entry) {
    return "";
  }

  const parts = [];
  if (entry.additions) {
    parts.push(`+${entry.additions}`);
  }
  if (entry.deletions) {
    parts.push(`-${entry.deletions}`);
  }
  return parts.join(" ");
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

        const change = describeChange(node.path, changes);
        const isModified = modifiedPaths.has(node.path);
        const isCurrent = node.path === currentPath;

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
                className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-0.5${isCurrent ? " font-semibold text-accent" : ""}`}
                onClick={() => {
                  if (onOpenFile) {
                    onOpenFile(node.path);
                    return;
                  }

                  void controls?.openFile(node.path);
                }}
              >
                <ExplorerFileSpacer />
                <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                <ExplorerModifiedDot hidden={!isModified} />
                <span
                  data-role="tree-change"
                  hidden={!change}
                  className="shrink-0 text-[0.8rem] text-muted"
                >
                  {change}
                </span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
