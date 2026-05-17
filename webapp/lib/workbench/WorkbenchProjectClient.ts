/*
 * Exports:
 * - WorkbenchProjectState: owned project list, selected tree, and explorer persistence state for the workbench. Keywords: workbench, project, tree, state.
 * - WorkbenchProjectSnapshot: readonly projection of the project list and selected project state. Keywords: workbench, project, snapshot, explorer.
 * - WorkbenchProjectListener: subscriber signature for project client state changes. Keywords: workbench, project, subscribe.
 * - cloneTreeNodes: deep-clone recursive tree node arrays for safe project snapshots. Keywords: workbench, project, tree, clone.
 * - WorkbenchProjectClient: public surface for the workbench project sub-client. Keywords: workbench, project, client, dispose, select.
 * - default WorkbenchProjectClient: create the project sub-client that owns project discovery, tree refresh, entry creation, and directory expansion state. Keywords: workbench, project, tree, entries, default export.
 */

import type { ChangeSummary, CreateEntryPayload, ProjectSnapshot, TreeNode, WorkbenchProjectOption, WorkbenchProjectsPayload } from "../types";
import { getRequestedProjectIdFromUrl, persistExpandedDirectories, readStoredExpandedDirectories } from "./state/browser-state";

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
  currentProjectId: string;
  expandedDirectories: Set<string>;
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  tree: TreeNode[];
}

export interface WorkbenchProjectSnapshot {
  changes: Record<string, ChangeSummary>;
  currentProjectId: string;
  expandedDirectories: string[];
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  tree: TreeNode[];
}

export type WorkbenchProjectListener = (snapshot: WorkbenchProjectSnapshot) => void;

interface WorkbenchProjectClient {
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  dispose: () => void;
  expandPath: (filePath: string) => boolean;
  getSnapshot: () => WorkbenchProjectSnapshot;
  selectProject: (projectId: string) => Promise<void>;
  refreshProject: () => Promise<ProjectSnapshot>;
  subscribe: (listener: WorkbenchProjectListener) => () => void;
  toggleDirectory: (path: string) => boolean;
}

function createInitialProjectState(): WorkbenchProjectState {
  return {
    changes: {},
    currentProjectId: "",
    expandedDirectories: new Set(readStoredExpandedDirectories()),
    projects: [],
    root: "Project",
    rootPath: "",
    tree: [],
  };
}

function WorkbenchProjectClient(): WorkbenchProjectClient {
  const listeners = new Set<WorkbenchProjectListener>();
  const state = createInitialProjectState();

  function getSnapshot(): WorkbenchProjectSnapshot {
    return {
      changes: { ...state.changes },
      currentProjectId: state.currentProjectId,
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      projects: state.projects.map((project) => ({ ...project })),
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
    state.currentProjectId = payload.projectId;
    state.root = payload.root;
    state.rootPath = payload.rootPath;
    state.tree = cloneTreeNodes(payload.tree);
    state.changes = { ...payload.changes };
  }

  async function refreshProjects() {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to load projects." }));
      throw new Error(error.error);
    }

    const payload = await response.json() as WorkbenchProjectsPayload;
    state.projects = payload.data;
    if (!state.currentProjectId) {
      const requestedProjectId = getRequestedProjectIdFromUrl();
      state.currentProjectId = state.projects.some((project) => project.id === requestedProjectId)
        ? requestedProjectId
        : state.projects[0]?.id ?? "";
      state.expandedDirectories = new Set(readStoredExpandedDirectories(state.currentProjectId));
    }
  }

  async function refreshProject() {
    await refreshProjects();
    if (!state.currentProjectId) {
      state.root = "No projects";
      state.rootPath = "";
      state.tree = [];
      state.changes = {};
      emit();
      return {
        changes: {},
        projectId: "",
        root: state.root,
        rootPath: state.rootPath,
        tree: [],
      };
    }

    const response = await fetch(`/api/tree?projectId=${encodeURIComponent(state.currentProjectId)}`, { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to load project." }));
      throw new Error(error.error);
    }

    const payload = await response.json() as ProjectSnapshot;
    applyProjectSnapshot(payload);
    emit();
    return payload;
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    if (!state.currentProjectId) {
      throw new Error("Select a project before creating files.");
    }

    const response = await fetch("/api/tree", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: state.currentProjectId,
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

    persistExpandedDirectories(state.expandedDirectories, state.currentProjectId);
    emit();
    return payload.path;
  }

  async function selectProject(projectId: string) {
    await refreshProjects();
    const selectedProjectId = state.projects.some((project) => project.id === projectId)
      ? projectId
      : state.projects[0]?.id ?? "";
    if (!selectedProjectId) {
      throw new Error("Unknown project.");
    }

    if (state.currentProjectId === selectedProjectId) {
      return;
    }

    state.currentProjectId = selectedProjectId;
    state.expandedDirectories = new Set(readStoredExpandedDirectories(selectedProjectId));
    await refreshProject();
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

    persistExpandedDirectories(state.expandedDirectories, state.currentProjectId);
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
      persistExpandedDirectories(state.expandedDirectories, state.currentProjectId);
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
    selectProject,
    refreshProject,
    subscribe,
    toggleDirectory,
  };
}

export default WorkbenchProjectClient;
