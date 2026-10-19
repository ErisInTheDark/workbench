/*
 * Exports:
 * - default WorkbenchExplorerSection: the browsed folder's explorer sidebar section: its file tree with unsaved new
 *   files, the unopenable-file toggle, and the menus that create markdown and svg drafts, reveal entries and delete files
 *   (holding to confirm what git cannot restore).
 */
"use client";

import { useCallback, useContext, useMemo, useState, type MouseEvent } from "react";

import type { TreeNode } from "workbench-shared/types";
import {
  createFileRoute, createLogicalFileRoute, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { flattenProjectTreeFiles, isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import { FileActionContext, resolveFileOpenDestination } from "../../../workbench/file/use-file";
import { useWorkbenchNavigate } from "../../../workbench/navigation/use-workbench-project-navigation";
import IconButton from "../../ui/IconButton";
import FileKindIcon from "../file-kind-icon";
import SidebarLoadingSkeleton from "../SidebarLoadingSkeleton";
import { NEW_SVG_SOURCE } from "../svg/WorkbenchSvgFileView";
import { useSettings } from "../use-settings";
import { useWorkbenchClientController } from "../workbench-client-context";
import { workbenchNewEntryButtonClassName } from "../workbench-class-names";
import { BinIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, FilePlusIcon, FolderOpenIcon } from "../workbench-icons";
import { useWorkbenchContextMenu, type WorkbenchContextMenuDefinition } from "../WorkbenchContextMenuContext";
import WorkbenchSidebarSectionDisclosure from "../WorkbenchSidebarSectionDisclosure";
import ExplorerTree from "./ExplorerTree";
import { useWorkbenchExplorer } from "./workbench-explorer-context";

/** What git cannot bring back is only removed by a deliberate hold. */
const PERMANENT_REMOVAL_HOLD_MS = 2000;
const NEW_FILE_CONTENT: Record<".md" | ".svg", string> = { ".md": "", ".svg": NEW_SVG_SOURCE };

/** Workspace roots qualify paths as `root:relative`, so a root folder's children follow its colon directly. */
function childPath(folderPath: string, name: string) {
  if (!folderPath) return name;
  return folderPath.endsWith(":") ? `${folderPath}${name}` : `${folderPath}/${name}`;
}

function parentPath(filePath: string) {
  const slash = filePath.lastIndexOf("/");
  if (slash >= 0) return filePath.slice(0, slash);
  const colon = filePath.indexOf(":");
  return colon >= 0 ? filePath.slice(0, colon + 1) : "";
}

function filterOpenableNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node): TreeNode[] => {
    if (node.type === "file") return isWorkbenchOpenableFile(node.path) ? [node] : [];
    const children = filterOpenableNodes(node.children);
    return children.length ? [{ ...node, children }] : [];
  });
}

/** New files exist only as drafts; they sit in their folders beside the files on disk until saved or discarded. */
function withNewFileDrafts(nodes: readonly TreeNode[], draftPaths: readonly string[], folderPath = ""): TreeNode[] {
  const merged = nodes.map(node => node.type === "directory"
    ? { ...node, children: withNewFileDrafts(node.children, draftPaths, node.path) } : node);
  const present = new Set(merged.map(node => node.path));
  const drafts = draftPaths
    .filter(path => parentPath(path) === folderPath && !present.has(path))
    .map((path): TreeNode => ({ type: "file", name: path.slice(parentPath(path).length).replace(/^\//u, ""), path }));
  if (!drafts.length) return merged;
  const files = [...merged.filter(node => node.type === "file"), ...drafts]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  return [...merged.filter(node => node.type === "directory"), ...files];
}

export default function WorkbenchExplorerSection({ currentPath, onFileDeleted, route }: {
  /** The file the main pane shows, highlighted in the tree. */
  currentPath: string;
  /** Close the views of a deleted file or discarded draft. */
  onFileDeleted: (path: string) => void;
  route: WorkbenchRoute;
}) {
  const explorer = useWorkbenchExplorer();
  const mounted = useWorkbenchClientController().mounted;
  const controls = mounted?.controls ?? null;
  const workspace = mounted?.workspace ?? null;
  const openFile = useContext(FileActionContext);
  const navigate = useWorkbenchNavigate();
  const { openContextMenu } = useWorkbenchContextMenu();
  const browseLocation = explorer.browseLocation ?? null;
  const browseSettings = useSettings.forLocation(browseLocation);
  const fileOpenPolicyFor = useSettings.fileOpenPolicy();
  const [actionError, setActionError] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const projectId = explorer.currentProjectId || route.projectId;
  const isProjectIdentityLoading = Boolean(route.projectId) && route.projectId !== explorer.currentProjectId;
  const isTreeLoading = isProjectIdentityLoading || (explorer.isProjectLoading && explorer.tree.length === 0);
  const showUnopenableFiles = browseSettings.get("showUnopenableFiles");
  const visibilityLabel = showUnopenableFiles ? "Hide files the workbench can't open" : "Show files the workbench can't open";
  const newFileDraftPaths = useMemo(() => new Set(explorer.newFileDraftPaths), [explorer.newFileDraftPaths]);
  const visibleTree = useMemo(() => isTreeLoading ? []
    : withNewFileDrafts(showUnopenableFiles ? explorer.tree : filterOpenableNodes(explorer.tree), explorer.newFileDraftPaths),
  [explorer.newFileDraftPaths, explorer.tree, isTreeLoading, showUnopenableFiles]);

  const isFileOpenable = useCallback((path: string) => (
    resolveFileOpenDestination({ path }, fileOpenPolicyFor(browseLocation)) !== null
  ), [browseLocation, fileOpenPolicyFor]);

  /** Revealing is a folder command, so it goes to the browsed folder's daemon. */
  const reveal = useCallback(async (path: string) => {
    if (!browseLocation) return;
    setActionError("");
    try {
      if (!workspace) throw new Error("The daemon is not ready.");
      await workspace.daemon({ kind: "folder", location: browseLocation }).nativeFiles
        .reveal({ path, projectId: browseLocation.projectId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to show that entry in the file explorer.");
    }
  }, [browseLocation, workspace]);

  const deleteFile = useCallback(async (path: string, confirmUntracked: boolean) => {
    if (!controls || deletingPath) return;
    setDeletingPath(path);
    setActionError("");
    try {
      const result = await controls.deleteFile(path, { confirmUntracked });
      if (result.confirmationRequired) {
        setActionError(`Git doesn't track ${result.path}, so it was kept. Hold "Delete permanently" in its menu to remove it.`);
        return;
      }
      onFileDeleted(result.path);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete that file.");
    } finally {
      setDeletingPath(null);
    }
  }, [controls, deletingPath, onFileDeleted]);

  const discardDraft = useCallback(async (path: string) => {
    if (!controls) return;
    setActionError("");
    try {
      await controls.discardFileDraft(path);
      onFileDeleted(path);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to discard that draft.");
    }
  }, [controls, onFileDeleted]);

  const createDraft = useCallback((folderPath: string, extension: ".md" | ".svg") => {
    if (!controls) return;
    const taken = new Set([...flattenProjectTreeFiles(explorer.tree), ...explorer.newFileDraftPaths]);
    let path = childPath(folderPath, `untitled${extension}`);
    for (let suffix = 2; taken.has(path); suffix += 1) path = childPath(folderPath, `untitled-${suffix}${extension}`);
    setActionError("");
    try {
      controls.createFileDraft(path, NEW_FILE_CONTENT[extension]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to start a new file.");
      return;
    }
    navigate(route.logical?.projectId && browseLocation
      ? createLogicalFileRoute(route.logical.projectId, browseLocation, path)
      : createFileRoute(projectId, path), { tab: "durable" });
  }, [browseLocation, controls, explorer.newFileDraftPaths, explorer.tree, navigate, projectId, route.logical?.projectId]);

  const folderMenu = useCallback((folderPath: string, name: string): WorkbenchContextMenuDefinition => ({
    id: `project-entry:directory:${folderPath}`,
    items: [
      {
        icon: <FileKindIcon path="new.md" size={16} />,
        id: "create-markdown",
        label: "Create markdown file",
        onSelect: () => createDraft(folderPath, ".md"),
      },
      {
        icon: <FileKindIcon path="new.svg" size={16} />,
        id: "create-svg",
        label: "Create svg file",
        onSelect: () => createDraft(folderPath, ".svg"),
      },
      { id: "reveal-separator", kind: "separator" },
      {
        icon: <ExternalLinkIcon size={16} />,
        id: "reveal",
        label: "Show in File Explorer",
        onSelect: () => { void reveal(folderPath); },
      },
    ],
    label: `Folder actions for ${name}`,
  }), [createDraft, reveal]);

  const getNodeContextMenu = useCallback((node: TreeNode): WorkbenchContextMenuDefinition => {
    if (node.type === "directory") return folderMenu(node.path, node.name);
    const id = `project-entry:file:${node.path}`;
    const label = `File actions for ${node.name}`;
    if (newFileDraftPaths.has(node.path)) {
      return { id, label, items: [{
        holdToConfirmMs: PERMANENT_REMOVAL_HOLD_MS,
        icon: <BinIcon size={20} />,
        id: "discard-draft",
        label: "Discard draft",
        onSelect: () => { void discardDraft(node.path); },
        tone: "danger",
      }] };
    }
    return { id, label, items: [
      {
        icon: <ExternalLinkIcon size={16} />,
        id: "reveal",
        label: "Show in File Explorer",
        onSelect: () => { void reveal(node.path); },
      },
      node.isUntracked ? {
        holdToConfirmMs: PERMANENT_REMOVAL_HOLD_MS,
        icon: <BinIcon size={20} />,
        id: "delete",
        label: "Delete permanently",
        onSelect: () => { void deleteFile(node.path, true); },
        tone: "danger",
      } : {
        icon: <BinIcon size={20} />,
        id: "delete",
        label: "Delete file",
        onSelect: () => { void deleteFile(node.path, false); },
        tone: "danger",
      },
    ] };
  }, [deleteFile, discardDraft, folderMenu, newFileDraftPaths, reveal]);

  /** Create buttons open their folder's menu just below themselves. */
  const openFolderMenu = useCallback((event: MouseEvent<HTMLElement>, folderPath: string, name: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu({ menu: folderMenu(folderPath, name), x: rect.left, y: rect.bottom + 4 });
  }, [folderMenu, openContextMenu]);

  return (
    <section className="shrink-0 pb-3">
      <WorkbenchSidebarSectionDisclosure
        actions={(
          <div className="flex items-center gap-1">
            <IconButton
              type="button"
              label={visibilityLabel}
              display="hover-border"
              size="small"
              aria-pressed={showUnopenableFiles}
              disabled={!explorer.currentProjectId || isTreeLoading}
              className={workbenchNewEntryButtonClassName}
              onClick={() => {
                void browseSettings.set("showUnopenableFiles", !showUnopenableFiles)
                  .catch((error: Error) => setActionError(error.message));
              }}
            >
              {showUnopenableFiles ? <EyeIcon size={16} /> : <EyeOffIcon size={16} />}
            </IconButton>
            <IconButton
              type="button"
              label="Create in project"
              display="hover-border"
              size="small"
              className={workbenchNewEntryButtonClassName}
              disabled={!explorer.currentProjectId || isTreeLoading}
              onClick={(event) => openFolderMenu(event, "", "the project")}
            >
              <FilePlusIcon size={16} />
            </IconButton>
          </div>
        )}
        contentClassName="space-y-2"
        icon={FolderOpenIcon}
        preferenceKey="explorerOpen"
        title="Explorer"
      >
        {!explorer.projects.length && !isProjectIdentityLoading ? (
          <p className="m-0 pr-2 text-[0.84rem] leading-6 text-fg/muted md:pr-4.5">
            No projects were found.
          </p>
        ) : null}
        {isTreeLoading ? (
          <SidebarLoadingSkeleton ariaLabel="Loading project files" rows={8} />
        ) : (
          <nav id="file-tree" aria-label="Project files">
            <ExplorerTree
              currentPath={currentPath}
              getNodeContextMenu={getNodeContextMenu}
              isFileOpenable={isFileOpenable}
              newFileDraftPaths={newFileDraftPaths}
              nodes={visibleTree}
              onCreateIn={(event, node) => openFolderMenu(event, node.path, node.name)}
              onOpenFile={(path) => { void openFile?.({ path, projectId }, null); }}
            />
          </nav>
        )}
        {actionError ? (
          <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger md:pr-4.5">{actionError}</p>
        ) : null}
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
