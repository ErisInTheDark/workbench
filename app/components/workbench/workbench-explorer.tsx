/*
 * Exports:
 * - NewEntryIcon: shared file-creation glyph alias.
 * - FileVisibilityIcon: select the shared eye glyph for the current file-visibility state.
 * - SidebarLoadingSkeleton: animated placeholder rows for loading sidebar sections.
 * - BrowseSessionsList: active Browse sessions in the sidebar.
 * - ExplorerTree: recursive project tree with current, modified and create-entry state.
 */
"use client";

import { useMemo, type PointerEvent, type ReactNode } from "react";

import type {
  ChangeSummary,
  TreeNode,
  WorkbenchBrowseSessionSummary,
  WorkbenchControls
} from "workbench-shared/types";
import type { WorkbenchDragPayload } from "../../workbench/layout/workbench-drag";
import ChevronIcon from "./ChevronIcon";
import ContextMenuCapability from "./ContextMenuCapability";
import {
  workbenchOptionHoverClassName,
  workbenchOptionRowClassName,
  workbenchOptionSelectedClassName,
  workbenchNewEntryButtonClassName,
  workbenchThreadListButtonClassName,
  workbenchThreadListLabelClassName,
} from "./workbench-class-names";
import { BrowserSessionIcon, EyeIcon, EyeOffIcon, FilePlusIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

export const NewEntryIcon = FilePlusIcon;

export function FileVisibilityIcon ({ visible }: { visible: boolean }) {
  return visible ? <EyeIcon size={16} /> : <EyeOffIcon size={16} />;
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
                    <BrowserSessionIcon className="shrink-0" size={16} />
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

function formatBrowseSessionDetail (session: WorkbenchBrowseSessionSummary) {
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
                    aria-expanded={isExpanded}
                    className={`${workbenchOptionRowClassName} ${workbenchOptionHoverClassName} max-w-full border-transparent text-muted hover:text-text`}
                    onClick={() => {
                      controls?.toggleDirectory(node.path);
                    }}
                  >
                    <ChevronIcon
                      data-role="tree-chevron"
                      className="mt-0.5 transition-transform"
                      size={18}
                      style={{
                        transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                      }}
                    />
                    <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                    <ExplorerModifiedDot hidden={!isModified} />
                    <ExplorerChangeSummary summary={changeSummary} />
                  </button>
                  <WorkbenchIconButton
                    type="button"
                    label={`Create in ${node.name}`}
                    display="hover-border"
                    size="small"
                    title={`Create in ${node.name}`}
                    className={workbenchNewEntryButtonClassName}
                    onClick={() => {
                      onCreateInDirectory?.(node.path);
                    }}
                  >
                    <NewEntryIcon size={16} />
                    <span className="sr-only">{`Create in ${node.name}`}</span>
                  </WorkbenchIconButton>
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
                  aria-current={isCurrent ? "page" : undefined}
                  className={`
                    ${workbenchOptionRowClassName} max-w-full
                    ${isCurrent ? `${workbenchOptionSelectedClassName} font-semibold text-text` : `border-transparent text-muted ${isOpenable ? `${workbenchOptionHoverClassName} hover:text-text` : ""}`}
                  `}
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
