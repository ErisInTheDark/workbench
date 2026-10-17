/*
 * Exports:
 * - FolderEntries: one folder's files and folders in tree order, with its path ("" is the project root).
 * - folderOf: the folder path an entry sits in.
 * - default useFolderEntries: observe the project tree of a folder location and read the entries beside one path.
 */
"use client";

import { useContext, useMemo } from "react";
import type { TreeNode } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchClientContext from "../../components/workbench/workbench-client-context";
import useWorkspaceObservation from "../app/use-workspace-observation";

export interface FolderEntries {
  entries: readonly TreeNode[];
  folder: string;
}

export function folderOf(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function childrenOf(tree: readonly TreeNode[], folder: string): readonly TreeNode[] | null {
  if (!folder) return tree;
  for (const node of tree) {
    if (node.type !== "directory") continue;
    if (node.path === folder) return node.children;
    if (folder.startsWith(`${node.path}/`)) return childrenOf(node.children, folder);
  }
  return null;
}

/** Null until the project tree has loaded, or when the folder is not in it. */
export default function useFolderEntries(location: ProjectLocationReference | null, path: string): FolderEntries | null {
  const workspace = useContext(WorkbenchClientContext)?.mounted?.workspace ?? null;
  const query = useMemo(() => location ? { kind: "projectTree" as const, location } : null,
    [location?.daemonId, location?.projectId]);
  const snapshot = useWorkspaceObservation(workspace, query);
  const tree = snapshot.value?.data?.snapshot.tree ?? null;
  const folder = folderOf(path);
  return useMemo(() => {
    const entries = tree ? childrenOf(tree, folder) : null;
    return entries ? { entries, folder } : null;
  }, [folder, tree]);
}
