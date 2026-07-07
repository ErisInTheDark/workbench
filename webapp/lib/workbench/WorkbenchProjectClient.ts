/*
 * Exports:
 * - WorkbenchProjectState: owned project list, selected tree, and explorer persistence state for the workbench. Keywords: workbench, project, tree, state.
 * - WorkbenchProjectSnapshot: readonly projection of the project list and selected project state. Keywords: workbench, project, snapshot, explorer.
 * - WorkbenchProjectListener: subscriber signature for project client state changes. Keywords: workbench, project, subscribe.
 * - cloneTreeNodes: deep-clone recursive tree node arrays for safe project snapshots. Keywords: workbench, project, tree, clone.
 * - WorkbenchProjectClient: public surface for the workbench project sub-client. Keywords: workbench, project, client, dispose, select.
 * - default WorkbenchProjectClient: create the project sub-client that owns project discovery, tree refresh, entry creation, and directory expansion state. Keywords: workbench, project, tree, entries, default export.
 */

import type { ChangeSummary, CreateEntryPayload, ProjectSnapshot, TreeNode, WorkbenchProjectOption, WorkbenchProjectRoot, WorkbenchProjectsPayload } from "../types";
import { areDeeplyEqual } from "./deep-equality";
import ProjectTreeFileIndex, { type ProjectTreeFileCandidate, type ProjectTreeFileIndex as ProjectTreeFileIndexRecord } from "./project/ProjectTreeFileIndex";
import { persistExpandedDirectories, readStoredExpandedDirectories } from "./state/browser-state";

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
  fileIndex: ProjectTreeFileIndexRecord;
  hasLoadedProject: boolean;
  isLoading: boolean;
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  roots: WorkbenchProjectRoot[];
  tree: TreeNode[];
  workbenchStorageRootPath: string;
}

export interface WorkbenchProjectSnapshot {
  changes: Record<string, ChangeSummary>;
  currentProjectId: string;
  expandedDirectories: string[];
  isLoading: boolean;
  projectFileCandidates: readonly ProjectTreeFileCandidate[];
  projectFileIndexId: string;
  projectFileIndexKey: string;
  projectFilePaths: readonly string[];
  projects: WorkbenchProjectOption[];
  root: string;
  rootPath: string;
  roots: WorkbenchProjectRoot[];
  tree: TreeNode[];
  workbenchStorageRootPath: string;
}

export type WorkbenchProjectListener = (snapshot: WorkbenchProjectSnapshot) => void;

interface WorkbenchProjectClient {
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  dispose: () => void;
  expandPath: (filePath: string) => boolean;
  getSnapshot: () => WorkbenchProjectSnapshot;
  selectInitialProject: () => Promise<void>;
  selectProjectStrict: (projectId: string) => Promise<boolean>;
  refreshProject: () => Promise<ProjectSnapshot>;
  subscribe: (listener: WorkbenchProjectListener) => () => void;
  toggleDirectory: (path: string) => boolean;
}

function createInitialProjectState(): WorkbenchProjectState {
  return {
    changes: {},
    currentProjectId: "",
    expandedDirectories: new Set(readStoredExpandedDirectories()),
    fileIndex: ProjectTreeFileIndex.empty,
    hasLoadedProject: false,
    isLoading: false,
    projects: [],
    root: "Project",
    rootPath: "",
    roots: [],
    tree: [],
    workbenchStorageRootPath: "",
  };
}

function WorkbenchProjectClient(): WorkbenchProjectClient {
  const listeners = new Set<WorkbenchProjectListener>();
  const state = createInitialProjectState();
  let projectLoadGeneration = 0;
  let snapshotDirty = true;
  let snapshot: WorkbenchProjectSnapshot | null = null;

  function buildSnapshot(): WorkbenchProjectSnapshot {
    return {
      changes: { ...state.changes },
      currentProjectId: state.currentProjectId,
      expandedDirectories: Array.from(state.expandedDirectories).sort((left, right) => left.localeCompare(right)),
      isLoading: state.isLoading,
      projectFileCandidates: state.fileIndex.candidates,
      projectFileIndexId: state.fileIndex.id,
      projectFileIndexKey: state.fileIndex.key,
      projectFilePaths: state.fileIndex.paths,
      projects: state.projects.map((project) => ({ ...project })),
      root: state.root,
      rootPath: state.rootPath,
      roots: state.roots.map((root) => ({ ...root })),
      tree: cloneTreeNodes(state.tree),
      workbenchStorageRootPath: state.workbenchStorageRootPath,
    };
  }

  function markSnapshotDirty() {
    snapshotDirty = true;
  }

  function getSnapshot(): WorkbenchProjectSnapshot {
    if (!snapshotDirty && snapshot) {
      return snapshot;
    }

    snapshot = buildSnapshot();
    snapshotDirty = false;
    return snapshot;
  }

  function emit() {
    markSnapshotDirty();
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function applyProjectSnapshot(payload: ProjectSnapshot) {
    const nextHasLoadedProject = true;
    const nextIsLoading = false;
    const didChange = state.currentProjectId !== payload.projectId
      || state.root !== payload.root
      || state.rootPath !== payload.rootPath
      || state.workbenchStorageRootPath !== payload.workbenchStorageRootPath
      || state.hasLoadedProject !== nextHasLoadedProject
      || state.isLoading !== nextIsLoading
      || !areDeeplyEqual(state.roots, payload.roots)
      || !areDeeplyEqual(state.tree, payload.tree)
      || !areDeeplyEqual(state.changes, payload.changes);

    if (!didChange) {
      return false;
    }

    state.currentProjectId = payload.projectId;
    state.root = payload.root;
    state.rootPath = payload.rootPath;
    state.roots = payload.roots.map((root) => ({ ...root }));
    state.tree = cloneTreeNodes(payload.tree);
    state.workbenchStorageRootPath = payload.workbenchStorageRootPath;
    state.fileIndex = ProjectTreeFileIndex.fromTree(state.tree, state.fileIndex);
    state.changes = { ...payload.changes };
    state.hasLoadedProject = nextHasLoadedProject;
    state.isLoading = nextIsLoading;
    markSnapshotDirty();
    return true;
  }

  function applyProjectOption(project: WorkbenchProjectOption, options: { loading?: boolean } = {}) {
    projectLoadGeneration += 1;
    state.currentProjectId = project.id;
    state.root = project.name || project.id;
    state.rootPath = project.rootPath;
    state.roots = project.roots.map((root) => ({ ...root }));
    state.tree = [];
    state.fileIndex = ProjectTreeFileIndex.empty;
    state.changes = {};
    state.hasLoadedProject = false;
    state.isLoading = options.loading ?? state.isLoading;
  }

  async function refreshProjects() {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unable to load projects." }));
      throw new Error(error.error);
    }

    const payload = await response.json() as WorkbenchProjectsPayload;
    if (areDeeplyEqual(state.projects, payload.data)) {
      return false;
    }

    state.projects = payload.data;
    markSnapshotDirty();
    return true;
  }

  async function refreshProject({ refreshProjectList = true }: { refreshProjectList?: boolean } = {}) {
    let didProjectListChange = false;
    if (refreshProjectList) {
      didProjectListChange = await refreshProjects();
    }
    if (!state.currentProjectId) {
      const didChange = state.root !== "No projects"
        || state.rootPath !== ""
        || state.roots.length > 0
        || state.tree.length > 0
        || state.fileIndex !== ProjectTreeFileIndex.empty
        || Object.keys(state.changes).length > 0
        || !state.hasLoadedProject
        || state.isLoading;

      state.root = "No projects";
      state.rootPath = "";
      state.roots = [];
      state.tree = [];
      state.fileIndex = ProjectTreeFileIndex.empty;
      state.changes = {};
      state.hasLoadedProject = true;
      state.isLoading = false;
      if (didProjectListChange || didChange) {
        emit();
      }
      return {
        changes: {},
        projectId: "",
        root: state.root,
        rootPath: state.rootPath,
        roots: [],
        tree: [],
        workbenchStorageRootPath: state.workbenchStorageRootPath,
      };
    }

    const refreshProjectId = state.currentProjectId;
    const refreshGeneration = ++projectLoadGeneration;

    const shouldShowLoading = !state.hasLoadedProject;
    if (shouldShowLoading && !state.isLoading) {
      state.isLoading = true;
      markSnapshotDirty();
      emit();
    }

    try {
      const response = await fetch(`/api/tree?projectId=${encodeURIComponent(state.currentProjectId)}`, { cache: "no-store" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unable to load project." }));
        throw new Error(error.error);
      }

      const payload = await response.json() as ProjectSnapshot;
      if (refreshGeneration !== projectLoadGeneration || payload.projectId !== refreshProjectId) {
        return payload;
      }

      const didProjectChange = applyProjectSnapshot(payload);
      if (didProjectListChange || didProjectChange) {
        emit();
      }
      return payload;
    } catch (error) {
      if (refreshGeneration === projectLoadGeneration && state.isLoading) {
        state.isLoading = false;
        markSnapshotDirty();
        emit();
      }
      throw error;
    }
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

  async function selectProjectStrict(projectId: string) {
    const cachedProject = state.projects.find((candidate) => candidate.id === projectId);
    if (cachedProject && state.currentProjectId !== projectId) {
      applyProjectOption(cachedProject, { loading: true });
      state.expandedDirectories = new Set(readStoredExpandedDirectories(projectId));
      emit();
    }

    const didRefreshProjectsChange = await refreshProjects();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      if (didRefreshProjectsChange) {
        emit();
      }
      return false;
    }

    if (state.currentProjectId === projectId && !state.isLoading) {
      if (didRefreshProjectsChange) {
        emit();
      }
      return true;
    }

    applyProjectOption(project, { loading: true });
    state.expandedDirectories = new Set(readStoredExpandedDirectories(projectId));
    emit();
    await refreshProject({ refreshProjectList: false });
    return true;
  }

  async function selectInitialProject() {
    const didRefreshProjectsChange = await refreshProjects();
    const initialProject = state.projects.find((project) => project.id === state.currentProjectId) ?? state.projects[0] ?? null;
    if (!state.currentProjectId && initialProject) {
      applyProjectOption(initialProject, { loading: true });
      state.expandedDirectories = new Set(readStoredExpandedDirectories(state.currentProjectId));
      emit();
    } else if (didRefreshProjectsChange) {
      emit();
    }
    if (state.currentProjectId) {
      await refreshProject({ refreshProjectList: false });
    }
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
    selectInitialProject,
    selectProjectStrict,
    refreshProject,
    subscribe,
    toggleDirectory,
  };
}

export default WorkbenchProjectClient;
