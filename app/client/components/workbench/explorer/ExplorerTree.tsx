/*
 * Exports:
 * - default ExplorerTree: the selected folder's recursive file tree with current, modified, change-count and new-draft
 *   state; files drag onto the main panel, folders and files carry their context menus.
 */
"use client";

import { useMemo, type MouseEvent } from "react";

import type { ChangeSummary, TreeNode } from "workbench-shared/types";
import IconButton from "../../ui/IconButton";
import ChevronIcon from "../ChevronIcon";
import ContextMenuCapability from "../ContextMenuCapability";
import { useWorkbenchDrag } from "../drag/workbench-drag-context";
import FileKindIcon from "../file-kind-icon";
import { useWorkbenchClientController } from "../workbench-client-context";
import {
  workbenchNewEntryButtonClassName,
  workbenchOptionHoverClassName,
  workbenchOptionRowClassName,
  workbenchOptionSelectedClassName,
} from "../workbench-class-names";
import { FilePlusIcon } from "../workbench-icons";
import type { WorkbenchContextMenuDefinition } from "../WorkbenchContextMenuContext";
import { useWorkbenchExplorer } from "./workbench-explorer-context";

interface ExplorerTreeDerivedState {
  changeSummariesByPath: ReadonlyMap<string, ChangeSummary>;
  modifiedPathsWithDescendants: ReadonlySet<string>;
}

/** Folders sum their files' change counts and show the modified dot when any descendant has a draft. */
function deriveTreeState(
  nodes: readonly TreeNode[],
  changes: Record<string, ChangeSummary>,
  modifiedPaths: ReadonlySet<string>,
): ExplorerTreeDerivedState {
  const changeSummariesByPath = new Map<string, ChangeSummary>();
  const modifiedPathsWithDescendants = new Set<string>();

  const visit = (node: TreeNode): ChangeSummary | null => {
    if (node.type === "file") {
      const summary = changes[node.path] ?? null;
      if (summary) changeSummariesByPath.set(node.path, summary);
      if (modifiedPaths.has(node.path)) modifiedPathsWithDescendants.add(node.path);
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
      if (modifiedPathsWithDescendants.has(child.path)) isModified = true;
    }
    if (isModified) modifiedPathsWithDescendants.add(node.path);
    if (!additions && !deletions) return null;
    const summary = { additions, deletions };
    changeSummariesByPath.set(node.path, summary);
    return summary;
  };

  for (const node of nodes) visit(node);
  return { changeSummariesByPath, modifiedPathsWithDescendants };
}

function ExplorerModifiedDot({ hidden }: { hidden: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--attention)]"
      aria-hidden="true"
    />
  );
}

function ExplorerChangeSummary({ summary }: { summary: ChangeSummary | null }) {
  if (!summary || (!summary.additions && !summary.deletions)) return null;
  return (
    <span data-role="tree-change" className="inline-flex shrink-0 items-center gap-1.5 text-[0.8rem]">
      {summary.additions ? <span className="text-[var(--explorer-change-add)]">+{summary.additions}</span> : null}
      {summary.deletions ? <span className="text-[var(--explorer-change-del)]">-{summary.deletions}</span> : null}
    </span>
  );
}

export default function ExplorerTree({
  currentPath,
  getNodeContextMenu,
  isFileOpenable,
  newFileDraftPaths,
  nodes,
  onCreateIn,
  onOpenFile,
}: {
  currentPath: string;
  getNodeContextMenu: (node: TreeNode) => WorkbenchContextMenuDefinition | null;
  isFileOpenable: (path: string) => boolean;
  /** Unsaved new files, shown in their folders until they are saved under a name or discarded. */
  newFileDraftPaths: ReadonlySet<string>;
  nodes: readonly TreeNode[];
  /** A folder's create button was pressed; the event's button anchors the menu. */
  onCreateIn: (event: MouseEvent<HTMLElement>, node: TreeNode & { type: "directory" }) => void;
  onOpenFile: (path: string) => void;
}) {
  const explorer = useWorkbenchExplorer();
  const controls = useWorkbenchClientController().controls;
  const beginDrag = useWorkbenchDrag.mainPanel();
  const expandedDirectories = useMemo(() => new Set(explorer.expandedDirectories), [explorer.expandedDirectories]);
  const derived = useMemo(() => deriveTreeState(nodes, explorer.changes, new Set(explorer.locallyModifiedPaths)),
    [explorer.changes, explorer.locallyModifiedPaths, nodes]);

  function renderNodes(level: readonly TreeNode[], nested: boolean) {
    return (
      <ul className={`m-0 p-0 ${nested ? "ml-4" : ""}`} data-role={nested ? "tree-group-nested" : "tree-group-root"}>
        {level.map((node) => {
          const changeSummary = derived.changeSummariesByPath.get(node.path) ?? null;
          const isModified = derived.modifiedPathsWithDescendants.has(node.path);
          const item = { "data-path": node.path, "data-tree-key": `${node.type}:${node.path}`, "data-tree-type": node.type };

          if (node.type === "directory") {
            const isExpanded = expandedDirectories.has(node.path);
            return (
              <li key={`${node.type}:${node.path}`} className="m-0 list-none" {...item}>
                <ContextMenuCapability menu={getNodeContextMenu(node)}>
                  <div className="group/entry-row flex min-w-0 items-center justify-between gap-2">
                    <button
                      data-role="tree-button"
                      type="button"
                      aria-expanded={isExpanded}
                      className={`${workbenchOptionRowClassName} ${workbenchOptionHoverClassName} max-w-full border-transparent text-fg/muted hover:text-text`}
                      onClick={() => controls?.toggleDirectory(node.path)}
                    >
                      <ChevronIcon
                        data-role="tree-chevron"
                        className="mt-0.5 transition-transform"
                        size={18}
                        style={{ transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)" }}
                      />
                      <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                      <ExplorerModifiedDot hidden={!isModified} />
                      <ExplorerChangeSummary summary={changeSummary} />
                    </button>
                    <IconButton
                      type="button"
                      label={`Create in ${node.name}`}
                      display="hover-border"
                      size="small"
                      title={`Create in ${node.name}`}
                      className={workbenchNewEntryButtonClassName}
                      onClick={(event) => onCreateIn(event, node)}
                    >
                      <FilePlusIcon size={16} />
                    </IconButton>
                  </div>
                </ContextMenuCapability>
                {isExpanded ? renderNodes(node.children, true) : null}
              </li>
            );
          }

          const isNewDraft = newFileDraftPaths.has(node.path);
          const isOpenable = isFileOpenable(node.path);
          const isCurrent = node.path === currentPath;
          return (
            <li key={`${node.type}:${node.path}`} className="m-0 list-none" {...item}>
              <ContextMenuCapability menu={getNodeContextMenu(node)}>
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    data-role="tree-button"
                    type="button"
                    aria-disabled={!isOpenable}
                    disabled={!isOpenable}
                    title={!isOpenable ? `${node.name} can't be opened in the workbench`
                      : isNewDraft ? `${node.name} (not saved yet)` : node.name}
                    aria-current={isCurrent ? "page" : undefined}
                    className={`
                      ${workbenchOptionRowClassName} max-w-full
                      ${isCurrent ? `${workbenchOptionSelectedClassName} font-semibold text-text`
                        : `border-transparent text-fg/muted ${isOpenable ? `${workbenchOptionHoverClassName} hover:text-text` : ""}`}
                    `}
                    onPointerDown={(event) => {
                      if (!isOpenable || isNewDraft) return;
                      event.stopPropagation();
                      beginDrag(event, { target: { filePath: node.path, kind: "file" }, type: "panel-target" });
                    }}
                    onClick={() => { if (isOpenable) onOpenFile(node.path); }}
                  >
                    <span data-role="tree-spacer" aria-hidden="true" className="flex size-[1.1rem] shrink-0 items-center justify-center">
                      <FileKindIcon path={node.path} size={16} />
                    </span>
                    <span data-role="tree-label" className={`min-w-0 truncate ${isNewDraft ? "italic" : ""}`}>{node.name}</span>
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

  return renderNodes(nodes, false);
}
