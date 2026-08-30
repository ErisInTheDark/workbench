/*
 * Exports:
 * - WorkbenchProjectState: owned project list, selected tree, and explorer persistence state for the workbench. Keywords: workbench, project, tree, state.
 * - WorkbenchProjectSnapshot: readonly projection of the project list and selected project state. Keywords: workbench, project, snapshot, explorer.
 * - WorkbenchProjectListener: subscriber signature for project client state changes. Keywords: workbench, project, subscribe.
 * - WorkbenchProjectTransport: project mutation and refresh requests carried by the existing Workbench bridge. Keywords: workbench, project, transport, websocket.
 * - WorkbenchProjectClientOptions: injected project transport and error boundary. Keywords: workbench, project, client, options.
 * - cloneTreeNodes: deep-clone recursive tree node arrays for safe project snapshots. Keywords: workbench, project, tree, clone.
 * - WorkbenchProjectClient: public surface for the workbench project sub-client. Keywords: workbench, project, client, dispose, select.
 * - default WorkbenchProjectClient: create the project sub-client that owns project discovery, tree refresh, entry creation/deletion, and directory expansion state. Keywords: workbench, project, tree, entries, delete, default export.
 */

import type { ChangeSummary, CreateEntryPayload, DeleteFileResponse, ProjectSnapshot, TreeNode, WorkbenchProjectOption, WorkbenchProjectRoot, WorkbenchProjectsPayload } from "../types";
import { WorkbenchProjectsPayloadSchema, type WorkbenchProjectStateUpdate } from "./project/project-state";
import { areDeeplyEqual } from "./deep-equality";
import ProjectTreeFileIndex, { type ProjectTreeFileCandidate, type ProjectTreeFileIndex as ProjectTreeFileIndexRecord } from "./project/ProjectTreeFileIndex";
import reportClientSchemaError from "./report-client-schema-error";
import WorkbenchClientStateController from "./state/WorkbenchClientStateController";
import { conformToZodSchema } from "./zod-schema-conformer";

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
  accept: (update: WorkbenchProjectStateUpdate) => void;
  beginProjectSelection: (projectId: string) => (() => void) | null;
  createEntry: (parentPath: string, name: string, type: "directory" | "file") => Promise<string>;
  deleteFile: (filePath: string, options?: { confirmUntracked?: boolean }) => Promise<DeleteFileResponse>;
  dispose: () => void;
  expandPath: (filePath: string) => boolean;
  getSnapshot: () => WorkbenchProjectSnapshot;
  installCatalog: (payload: WorkbenchProjectsPayload) => boolean;
  selectInitialProject: () => Promise<void>;
  selectProjectStrict: (projectId: string) => Promise<boolean>;
  refreshProject: () => Promise<void>;
  resetObservation: () => void;
  subscribe: (listener: WorkbenchProjectListener) => () => void;
  toggleDirectory: (path: string) => boolean;
}

export interface WorkbenchProjectTransport {
  readCatalog(): Promise<WorkbenchProjectsPayload>;
  createEntry(projectId: string, parentPath: string, name: string, type: "directory" | "file"): Promise<CreateEntryPayload>;
  deleteFile(projectId: string, filePath: string, options: { confirmUntracked?: boolean }): Promise<DeleteFileResponse>;
  refresh(projectId: string): Promise<void>;
}

export interface WorkbenchProjectClientOptions {
  clientStateController?: WorkbenchClientStateController;
  onError?: (message: string) => void;
  transport: WorkbenchProjectTransport;
}

function readExpandedDirectories(controller: WorkbenchClientStateController | undefined, projectId = "") {
  if (!controller || !projectId) return [];
  return controller.records("expandedDirectory").flatMap((record) => (
    record.daemonRegistrationId === controller.daemonRegistrationId && record.projectId === projectId
      ? [record.path]
      : []
  ));
}

function createInitialProjectState(controller: WorkbenchClientStateController | undefined): WorkbenchProjectState {
  return {
    changes: {},
    currentProjectId: "",
    expandedDirectories: new Set(readExpandedDirectories(controller)),
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

function WorkbenchProjectClient({
  clientStateController,
  onError = () => undefined,
  transport,
}: WorkbenchProjectClientOptions): WorkbenchProjectClient {
  const listeners = new Set<WorkbenchProjectListener>();
  const state = createInitialProjectState(clientStateController);
  let projectRevision = -1;
  let snapshotDirty = true;
  let snapshot: WorkbenchProjectSnapshot | null = null;

  function persistCurrentExpandedDirectories() {
    if (!clientStateController || !state.currentProjectId) return;
    const desired = new Set(state.expandedDirectories);
    const current = clientStateController.records("expandedDirectory").filter((record) => (
      record.daemonRegistrationId === clientStateController.daemonRegistrationId
      && record.projectId === state.currentProjectId
    ));
    const operations: Promise<unknown>[] = [];
    for (const record of current) {
      if (!desired.delete(record.path)) operations.push(clientStateController.delete({
        daemonRegistrationId: clientStateController.daemonRegistrationId,
        kind: "expandedDirectory",
        path: record.path,
        projectId: state.currentProjectId,
      }));
    }
    for (const path of desired) operations.push(clientStateController.put({
      daemonRegistrationId: clientStateController.daemonRegistrationId,
      kind: "expandedDirectory",
      path,
      projectId: state.currentProjectId,
    }));
    void Promise.all(operations).catch((error: Error) => onError(error.message));
  }

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
    state.currentProjectId = project.id;
    state.root = project.name || project.id;
    state.rootPath = project.rootPath;
    state.roots = project.roots.map((root) => ({ ...root }));
    state.tree = [];
    state.fileIndex = ProjectTreeFileIndex.empty;
    state.changes = {};
    state.hasLoadedProject = false;
    state.isLoading = options.loading ?? state.isLoading;
    projectRevision = -1;
  }

  function restoreProjectState(previous: WorkbenchProjectState, previousProjectRevision: number) {
    state.changes = { ...previous.changes };
    state.currentProjectId = previous.currentProjectId;
    state.expandedDirectories = new Set(previous.expandedDirectories);
    state.fileIndex = previous.fileIndex;
    state.hasLoadedProject = previous.hasLoadedProject;
    state.isLoading = previous.isLoading;
    state.projects = previous.projects.map((project) => ({ ...project, roots: project.roots.map((root) => ({ ...root })) }));
    state.root = previous.root;
    state.rootPath = previous.rootPath;
    state.roots = previous.roots.map((root) => ({ ...root }));
    state.tree = cloneTreeNodes(previous.tree);
    state.workbenchStorageRootPath = previous.workbenchStorageRootPath;
    projectRevision = previousProjectRevision;
    markSnapshotDirty();
  }

  function captureProjectState(): WorkbenchProjectState {
    return {
      changes: { ...state.changes },
      currentProjectId: state.currentProjectId,
      expandedDirectories: new Set(state.expandedDirectories),
      fileIndex: state.fileIndex,
      hasLoadedProject: state.hasLoadedProject,
      isLoading: state.isLoading,
      projects: state.projects.map((project) => ({ ...project, roots: project.roots.map((root) => ({ ...root })) })),
      root: state.root,
      rootPath: state.rootPath,
      roots: state.roots.map((root) => ({ ...root })),
      tree: cloneTreeNodes(state.tree),
      workbenchStorageRootPath: state.workbenchStorageRootPath,
    };
  }

  function beginProjectSelection(projectId: string) {
    const nextProjectId = projectId.trim();
    if (!nextProjectId || state.currentProjectId === nextProjectId) return null;
    const previousState = captureProjectState();
    const previousProjectRevision = projectRevision;
    const project = state.projects.find((candidate) => candidate.id === nextProjectId);
    if (project) applyProjectOption(project, { loading: true });
    else {
      state.currentProjectId = nextProjectId;
      state.root = nextProjectId;
      state.rootPath = "";
      state.roots = [];
      state.tree = [];
      state.fileIndex = ProjectTreeFileIndex.empty;
      state.changes = {};
      state.hasLoadedProject = false;
      state.isLoading = true;
      projectRevision = -1;
    }
    state.expandedDirectories = new Set(readExpandedDirectories(clientStateController, nextProjectId));
    emit();
    return () => {
      if (state.currentProjectId !== nextProjectId) return;
      restoreProjectState(previousState, previousProjectRevision);
      emit();
    };
  }

  function applyCatalog(payload: WorkbenchProjectsPayload) {
    const didProjectsChange = !areDeeplyEqual(state.projects, payload.data);
    if (didProjectsChange) state.projects = payload.data.map((project) => ({ ...project, roots: project.roots.map((root) => ({ ...root })) }));
    const currentProject = state.projects.find((project) => project.id === state.currentProjectId);
    let didMetadataChange = false;
    if (currentProject && !state.hasLoadedProject) {
      didMetadataChange = state.root !== (currentProject.name || currentProject.id)
        || state.rootPath !== currentProject.rootPath
        || !areDeeplyEqual(state.roots, currentProject.roots);
      state.root = currentProject.name || currentProject.id;
      state.rootPath = currentProject.rootPath;
      state.roots = currentProject.roots.map((root) => ({ ...root }));
    }
    if (didProjectsChange || didMetadataChange) markSnapshotDirty();
    return didProjectsChange || didMetadataChange;
  }

  function installCatalog(payload: WorkbenchProjectsPayload) {
    const didChange = applyCatalog(payload);
    if (didChange) emit();
    return didChange;
  }

  function accept(update: WorkbenchProjectStateUpdate) {
    if (update.projectId !== state.currentProjectId || update.revision <= projectRevision) return;
    projectRevision = update.revision;
    if (applyProjectSnapshot(update.snapshot)) emit();
  }

  function resetObservation() {
    projectRevision = -1;
  }

  async function refreshProjects() {
    const payload = await transport.readCatalog();
    const parsed = WorkbenchProjectsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      reportClientSchemaError("Repaired Workbench project catalog response", parsed.error);
    }
    return applyCatalog(conformToZodSchema(
      WorkbenchProjectsPayloadSchema,
      payload,
      { data: [], rootPath: "" },
    ).data);
  }

  async function refreshProject() {
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
      if (didChange) {
        emit();
      }
      return;
    }
    try {
      await transport.refresh(state.currentProjectId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to refresh the project.");
      throw error;
    }
  }

  async function createEntry(parentPath: string, name: string, type: "directory" | "file") {
    if (!state.currentProjectId) {
      throw new Error("Select a project before creating files.");
    }

    const payload = await transport.createEntry(state.currentProjectId, parentPath, name, type);

    if (parentPath) {
      state.expandedDirectories.add(parentPath);
    }
    if (type === "directory") {
      state.expandedDirectories.add(payload.path);
    }

    persistCurrentExpandedDirectories();
    emit();
    return payload.path;
  }

  async function deleteFile(filePath: string, options: { confirmUntracked?: boolean } = {}) {
    if (!state.currentProjectId) {
      throw new Error("Select a project before deleting files.");
    }

    return await transport.deleteFile(state.currentProjectId, filePath, options);
  }

  async function selectProjectStrict(projectId: string) {
    const rollbackSelection = beginProjectSelection(projectId);

    const didRefreshProjectsChange = await refreshProjects();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      rollbackSelection?.();
      return false;
    }

    if (state.currentProjectId === projectId && !state.isLoading) {
      if (didRefreshProjectsChange) {
        emit();
      }
      return true;
    }

    const didMetadataChange = applyCatalog({ data: state.projects, rootPath: "" });
    if (didRefreshProjectsChange || didMetadataChange) emit();
    return true;
  }

  async function selectInitialProject() {
    const didRefreshProjectsChange = await refreshProjects();
    const initialProject = state.projects.find((project) => project.id === state.currentProjectId) ?? state.projects[0] ?? null;
    if (!state.currentProjectId && initialProject) {
      applyProjectOption(initialProject, { loading: true });
      state.expandedDirectories = new Set(readExpandedDirectories(clientStateController, state.currentProjectId));
      emit();
    } else if (didRefreshProjectsChange) {
      emit();
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

    persistCurrentExpandedDirectories();
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
      persistCurrentExpandedDirectories();
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
    accept,
    beginProjectSelection,
    createEntry,
    deleteFile,
    dispose,
    expandPath,
    getSnapshot,
    installCatalog,
    selectInitialProject,
    selectProjectStrict,
    refreshProject,
    resetObservation,
    subscribe,
    toggleDirectory,
  };
}

export default WorkbenchProjectClient;
