/*
 * Exports:
 * - WorkbenchProjectState: owned project tree and explorer persistence state for the workbench. Keywords: workbench, project, tree, state.
 * - WorkbenchProjectSnapshot: readonly projection of the project client state. Keywords: workbench, project, snapshot, explorer.
 * - WorkbenchProjectListener: subscriber signature for project client state changes. Keywords: workbench, project, subscribe.
 * - cloneTreeNodes: deep-clone recursive tree node arrays for safe project snapshots. Keywords: workbench, project, tree, clone.
 * - WorkbenchProjectClient: public surface for the workbench project sub-client. Keywords: workbench, project, client, dispose.
 * - createWorkbenchProjectClient: create the project sub-client that owns tree refresh, entry creation, and directory expansion state. Keywords: workbench, project, tree, entries.
 */

import type { ChangeSummary, CreateEntryPayload, ProjectSnapshot, TreeNode } from "../types";
import { persistExpandedDirectories, readStoredExpandedDirectories } from "./browser-state";

export function cloneTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === "file") {
      return { ...node };
    }

    return {
      ...node,
      children: cloneTreeNodes(node.children),
    };
  });
}

export interface WorkbenchProjectState {
  changes: Record<string, ChangeSummary>;
  expandedDirectories: Set<string>;
  root: string;
  rootPath: string;
  tree: TreeNode[];
}

export interface WorkbenchProjectSnapshot {
  changes: Record<string, ChangeSummary>;
  expandedDirectories: string[];
  root: string;
  rootPath: string;
  tree: TreeNode[];
}

export type WorkbenchProjectListener = (snapshot: WorkbenchProjectSnapshot) => void;

export interface WorkbenchProjectClient {
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  dispose: () => void;
  expandPath: (filePath: string) => boolean;
  getSnapshot: () => WorkbenchProjectSnapshot;
  refreshProject: () => Promise<ProjectSnapshot>;
  subscribe: (listener: WorkbenchProjectListener) => () => void;
  toggleDirectory: (path: string) => boolean;
}

function createInitialProjectState(): WorkbenchProjectState {
  return {
    changes: {},
    expandedDirectories: new Set(readStoredExpandedDirectories()),
    root: "Project",
    rootPath: "",
    tree: [],
  };
}

export function createWorkbenchProjectClient(): WorkbenchProjectClient {
  const listeners = new Set<WorkbenchProjectListener>();
  const state = createInitialProjectState();

  function getSnapshot(): WorkbenchProjectSnapshot {
    return {
      changes: { ...state.changes },
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      root: state.root,
      rootPath: state.rootPath,
      tree: cloneTreeNodes(state.tree),
    };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function applyProjectSnapshot(payload: ProjectSnapshot) {
    state.root = payload.root;
    state.rootPath = payload.rootPath;
    state.tree = cloneTreeNodes(payload.tree);
    state.changes = { ...payload.changes };
  }

  async function refreshProject() {
    const response = await fetch("/api/tree", { cache: "no-store" });
    const payload = await response.json() as ProjectSnapshot;
    applyProjectSnapshot(payload);
    emit();
    return payload;
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    const response = await fetch("/api/tree", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parentPath,
        name,
        type,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to create entry." }));
      throw new Error(error.error);
    }

    const payload = await response.json() as CreateEntryPayload;
    applyProjectSnapshot(payload);

    if (parentPath) {
      state.expandedDirectories.add(parentPath);
    }
    if (type === "directory") {
      state.expandedDirectories.add(payload.path);
    }

    persistExpandedDirectories(state.expandedDirectories);
    emit();
    return payload.path;
  }

  function toggleDirectory(path: string) {
    if (!path) {
      return false;
    }

    if (state.expandedDirectories.has(path)) {
      state.expandedDirectories.delete(path);
    } else {
      state.expandedDirectories.add(path);
    }

    persistExpandedDirectories(state.expandedDirectories);
    emit();
    return true;
  }

  function expandPath(filePath: string) {
    let didExpand = false;
    const segments = filePath.split("/");
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      if (!state.expandedDirectories.has(current)) {
        state.expandedDirectories.add(current);
        didExpand = true;
      }
    }

    if (didExpand) {
      persistExpandedDirectories(state.expandedDirectories);
      emit();
    }

    return didExpand;
  }

  function subscribe(listener: WorkbenchProjectListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose() {
    listeners.clear();
  }

  return {
    createEntry,
    dispose,
    expandPath,
    getSnapshot,
    refreshProject,
    subscribe,
    toggleDirectory,
  };
}