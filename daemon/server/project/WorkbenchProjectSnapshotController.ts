/*
 * Exports:
 * - WorkbenchProjectSnapshotControllerOptions: injected project resolution, tree operations, tree watching, clock, polling, logging, and cache bound for deterministic lifecycle tests.
 * - ProjectTreeWatch: report that anything under a project's roots may have changed.
 * - default WorkbenchProjectSnapshotController: own one reloadable snapshot loop per observed project (walking the tree only for tree
 *   observers and reads, and for watched trees only after a change or a slow resync), file deletion, change-only publication, the
 *   HTTP tree read, and disposal.
 */
import { watch, type FSWatcher } from "node:fs";
import type http from "node:http";

import {
  assertProjectFileCanBeDeleted,
  deleteProjectFile,
  getProjectChanges,
  getProjectSnapshotFromResolvedProject,
  resolveProjectFilePath,
  type ResolvedProject,
} from "../lib/project";
import { isGitTrackedFile } from "../lib/git";
import type { DeleteFileResponse, ProjectSnapshot } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_PROJECT_SNAPSHOTS = 4;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** A watched tree is still walked this often, in case the platform dropped change events. */
const DEFAULT_TREE_RESYNC_MS = 60_000;

/** Calls `changed` when anything under the roots may have changed; returns a closer, or null when it cannot watch. */
export type ProjectTreeWatch = (roots: readonly string[], changed: () => void) => (() => void) | null;

/** Recursive platform watchers; Git's own files change on every status read, so they never mark the tree changed. */
const watchProjectTree: ProjectTreeWatch = (roots, changed) => {
  const watchers: FSWatcher[] = [];
  const close = () => { for (const watcher of watchers.splice(0)) watcher.close(); };
  try {
    for (const root of roots) {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const name = filename === null ? null : String(filename).replaceAll("\\", "/");
        if (name === ".git" || name?.startsWith(".git/")) return;
        changed();
      });
      // A broken watcher can no longer vouch for the tree, so the poll walks again.
      watcher.on("error", () => { close(); changed(); });
      watchers.push(watcher);
    }
  } catch {
    close();
    return null;
  }
  return close;
};

type SnapshotCacheState = "coalesced" | "hit" | "miss";

interface ProjectSnapshotState {
  expiresAt: number;
  failure: string | null;
  lastAccessAt: number;
  observers: Set<{
    publish(update: WorkbenchProjectStateUpdate): void;
    failed?(message: string): void;
    /** False for observers that read only Git changes; their polls skip the tree walk. */
    tree: boolean;
  }>;
  refreshPromise: Promise<ProjectSnapshot | null> | null;
  refreshRequested: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  revision: number;
  serialized: string | null;
  snapshot: ProjectSnapshot | null;
  /** Closes the tree watcher; null while unwatched, in which case every tree poll walks. */
  closeWatcher: (() => void) | null;
  /** Set by the watcher, explicit refreshes and invalidation; cleared as a walk starts. */
  treeChanged: boolean;
  walkedAt: number;
}

interface SnapshotResponse {
  cacheState: SnapshotCacheState;
  snapshot: ProjectSnapshot;
  serialized: string;
}

type ProjectOperations = {
  assertProjectFileCanBeDeleted: typeof assertProjectFileCanBeDeleted;
  deleteProjectFile: typeof deleteProjectFile;
  getProjectChanges: typeof getProjectChanges;
  getProjectSnapshot: typeof getProjectSnapshotFromResolvedProject;
  isGitTrackedFile: typeof isGitTrackedFile;
  resolveProjectFilePath: typeof resolveProjectFilePath;
};

export interface WorkbenchProjectSnapshotControllerOptions {
  observeProject?: (projectId: string) => void;
  cacheTtlMs?: number;
  logError?: (message: string) => void;
  maxProjectSnapshots?: number;
  now?: () => number;
  operations?: ProjectOperations;
  pollIntervalMs?: number;
  resolveProjectById: (projectId?: string | null) => Promise<ResolvedProject>;
  /** Lets tree polls skip unchanged trees; without one, every tree poll walks. */
  watchTree?: ProjectTreeWatch | null;
  treeResyncMs?: number;
}

function sendSerializedJson(response: http.ServerResponse, statusCode: number, serialized: string, cacheState?: SnapshotCacheState) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json",
    ...(cacheState ? { "X-Workbench-Snapshot-Cache": cacheState } : {}),
  });
  response.end(serialized);
}

function sendError(response: http.ServerResponse, error: unknown, fallback: string) {
  sendSerializedJson(response, 400, JSON.stringify({ error: error instanceof Error ? error.message : fallback }));
}

export default class WorkbenchProjectSnapshotController {
  private readonly cacheTtlMs: number;
  private disposed = false;
  private readonly logError: (message: string) => void;
  private readonly maxProjectSnapshots: number;
  private readonly now: () => number;
  private readonly operations: ProjectOperations;
  private readonly pollIntervalMs: number;
  private readonly projects = new Map<string, ProjectSnapshotState>();
  private readonly resolveProjectById: WorkbenchProjectSnapshotControllerOptions["resolveProjectById"];
  private readonly observeProject: (projectId: string) => void;
  private readonly watchTree: ProjectTreeWatch | null;
  private readonly treeResyncMs: number;

  constructor({
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    logError = (message) => console.error(message),
    maxProjectSnapshots = DEFAULT_MAX_PROJECT_SNAPSHOTS,
    now = Date.now,
    operations = {
      assertProjectFileCanBeDeleted, deleteProjectFile, getProjectChanges,
      getProjectSnapshot: getProjectSnapshotFromResolvedProject, isGitTrackedFile, resolveProjectFilePath,
    },
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    resolveProjectById,
    observeProject = () => undefined,
    watchTree = watchProjectTree,
    treeResyncMs = DEFAULT_TREE_RESYNC_MS,
  }: WorkbenchProjectSnapshotControllerOptions) {
    this.watchTree = watchTree;
    this.treeResyncMs = treeResyncMs;
    this.cacheTtlMs = cacheTtlMs;
    this.logError = logError;
    this.maxProjectSnapshots = Math.max(1, Math.trunc(maxProjectSnapshots));
    this.now = now;
    this.operations = operations;
    this.pollIntervalMs = Math.max(1, Math.trunc(pollIntervalMs));
    this.resolveProjectById = resolveProjectById;
    this.observeProject = observeProject;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.projects.values()) this.stopState(state);
    this.projects.clear();
  }

  observe(
    projectId: string,
    publish: (update: WorkbenchProjectStateUpdate) => void,
    failed?: (message: string) => void,
    { tree = true }: { tree?: boolean } = {},
  ) {
    this.assertActive();
    this.observeProject(projectId);
    const key = this.projectKey(projectId);
    const state = this.getState(key);
    const observer = { publish, failed, tree };
    state.lastAccessAt = this.now();
    state.observers.add(observer);
    if (state.snapshot) publish(this.toUpdate(state.snapshot, state.revision));
    if (state.failure) failed?.(state.failure);
    if (!state.refreshTimer && !state.refreshPromise) {
      this.scheduleRefresh(key, projectId, Math.max(0, state.expiresAt - this.now()));
    }
    return () => {
      state.observers.delete(observer);
      if (!state.observers.size) this.stopObservation(state);
    };
  }

  getCurrentUpdate(projectId: string) {
    this.assertActive();
    const state = this.projects.get(this.projectKey(projectId));
    return state?.snapshot ? this.toUpdate(state.snapshot, state.revision) : null;
  }

  async handleRequest(projectId: string, request: WorkbenchProjectStateRequest) {
    this.assertActive();
    if (request.projectId !== projectId) throw new Error("The project request does not belong to the observed project.");
    if (request.method === "workbench/thread-state/project/refresh") {
      const state = this.projects.get(this.projectKey(projectId));
      if (state) state.treeChanged = true;
      this.scheduleRefresh(this.projectKey(projectId), projectId, 0);
      return { accepted: true };
    }
    return await this.deleteFile(request);
  }

  async handleTreeHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET") {
        const result = await this.readSnapshot(requestUrl.searchParams.get("projectId"));
        sendSerializedJson(response, 200, result.serialized, result.cacheState);
        return;
      }
      sendSerializedJson(response, 405, JSON.stringify({ error: "Method not allowed" }));
    } catch (error) {
      sendError(response, error, "Unable to update project tree.");
    }
  }

  invalidateSnapshot(projectId: string) {
    const key = this.projectKey(projectId);
    const state = this.projects.get(key);
    if (!state) return;
    state.expiresAt = 0;
    state.treeChanged = true;
    this.scheduleRefresh(key, projectId, 0);
  }

  async refreshAfterFileMutation(projectId: string) {
    this.invalidateSnapshot(projectId);
    this.invalidateSnapshot("__default__");
    return (await this.readSnapshot(projectId)).snapshot;
  }

  async readProjectSnapshot(projectId: string) {
    return (await this.readSnapshot(projectId)).snapshot;
  }

  private async deleteFile(request: Extract<WorkbenchProjectStateRequest, { method: "workbench/thread-state/project/file/delete" }>): Promise<DeleteFileResponse> {
    const resolvedProject = await this.resolveProjectById(request.projectId);
    const resolvedFile = this.operations.resolveProjectFilePath(resolvedProject, request.path);
    await this.operations.assertProjectFileCanBeDeleted(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
    const tracked = await this.operations.isGitTrackedFile(resolvedFile.gitRoot, resolvedFile.rootRelativePath);
    if (!tracked && request.confirmUntracked !== true) {
      return { confirmationRequired: true, path: resolvedFile.displayPath, projectId: resolvedProject.id, tracked: false };
    }
    await this.operations.deleteProjectFile(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
    this.invalidateSnapshot(resolvedProject.id);
    this.invalidateSnapshot("__default__");
    await this.refreshNow(this.projectKey(resolvedProject.id), resolvedProject.id);
    return { path: resolvedFile.displayPath, tracked };
  }

  private projectKey(projectId: string | null) {
    return projectId?.trim() || "__default__";
  }

  private getState(key: string) {
    const existing = this.projects.get(key);
    if (existing) return existing;
    const state: ProjectSnapshotState = {
      expiresAt: 0,
      failure: null,
      lastAccessAt: this.now(),
      observers: new Set(),
      refreshPromise: null,
      refreshRequested: false,
      refreshTimer: null,
      revision: 0,
      serialized: null,
      snapshot: null,
      closeWatcher: null,
      treeChanged: true,
      walkedAt: 0,
    };
    this.projects.set(key, state);
    return state;
  }

  private async readSnapshot(projectId: string | null): Promise<SnapshotResponse> {
    this.assertActive();
    const key = this.projectKey(projectId);
    const state = this.getState(key);
    const now = this.now();
    state.lastAccessAt = now;
    if (state.snapshot && state.expiresAt > now) {
      return { cacheState: "hit", serialized: state.serialized ??= JSON.stringify(state.snapshot), snapshot: state.snapshot };
    }
    const cacheState: SnapshotCacheState = state.refreshPromise ? "coalesced" : "miss";
    await this.refreshNow(key, projectId);
    // A joined change-only refresh never makes the tree fresh; this read needs the tree.
    if (!state.failure && state.expiresAt <= this.now()) await this.refreshNow(key, projectId, true);
    if (state.failure) throw new Error(state.failure);
    if (!state.snapshot) throw new Error("Project tree refresh did not produce a snapshot.");
    return { cacheState, serialized: state.serialized ??= JSON.stringify(state.snapshot), snapshot: state.snapshot };
  }

  /**
   * Only observers that show the tree make a poll walk it; change-only observers (working-tree badges) read Git alone.
   * A watched tree is walked only once something under it changed, or on the slow resync.
   */
  private pollsTree(state: ProjectSnapshotState) {
    if (!state.snapshot) return true;
    if (![...state.observers].some(observer => observer.tree)) return false;
    return !state.closeWatcher || state.treeChanged || this.now() - state.walkedAt >= this.treeResyncMs;
  }

  private ensureTreeWatcher(key: string, state: ProjectSnapshotState, project: ResolvedProject) {
    if (state.closeWatcher || !this.watchTree || project.kind === "daemon" || !state.observers.size) return;
    if (![...state.observers].some(observer => observer.tree)) return;
    const roots = project.roots.length ? project.roots.map(root => root.root) : [project.root];
    state.closeWatcher = this.watchTree(roots, () => {
      if (this.projects.get(key) === state) state.treeChanged = true;
    });
  }

  private closeTreeWatcher(state: ProjectSnapshotState) {
    state.closeWatcher?.();
    state.closeWatcher = null;
    state.treeChanged = true;
  }

  private scheduleRefresh(key: string, projectId: string | null, delayMs: number) {
    const state = this.projects.get(key);
    if (!state?.observers.size || this.disposed) return;
    if (state.refreshPromise) {
      state.refreshRequested = true;
      return;
    }
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void this.refreshNow(key, projectId, this.pollsTree(state));
    }, delayMs);
    state.refreshTimer.unref?.();
  }

  private async refreshNow(key: string, projectId: string | null, tree = true) {
    const state = this.getState(key);
    if (state.refreshPromise) {
      return await state.refreshPromise;
    }
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.refreshRequested = false;
    const walk = tree || !state.snapshot;
    // Changes seen while this walk runs belong to the next one.
    if (walk) state.treeChanged = false;
    const promise = this.resolveProjectById(projectId).then(async (project): Promise<ProjectSnapshot> => {
      if (!this.disposed) this.ensureTreeWatcher(key, state, project);
      if (walk || !state.snapshot) return await this.operations.getProjectSnapshot(project);
      const changes = await this.operations.getProjectChanges(project);
      return { ...state.snapshot, changes };
    }).then((snapshot) => {
      if (this.disposed) return null;
      this.installSnapshot(key, state, snapshot, walk);
      return snapshot;
    }).catch((error: unknown) => {
      if (this.disposed) return null;
      // A failed walk proved nothing about the tree.
      if (walk) state.treeChanged = true;
      const failure = (error instanceof Error ? error.message : "Project snapshot refresh failed.")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
      if (state.failure !== failure) {
        state.failure = failure;
        this.logError(`Project snapshot refresh failed for ${key}: ${failure}`);
        for (const observer of state.observers) {
          try { observer.failed?.(failure); }
          catch (observerError) { this.reportObserverFailure(observerError); }
        }
      }
      return null;
    }).finally(() => {
      state.refreshPromise = null;
      if (!state.observers.size || this.disposed) return;
      const delay = state.refreshRequested ? 0 : this.pollIntervalMs;
      state.refreshRequested = false;
      this.scheduleRefresh(key, projectId, delay);
    });
    state.refreshPromise = promise;
    return await promise;
  }

  /** Only a walked tree is fresh; a change-only refresh keeps the previous tree's expiry. */
  private installSnapshot(key: string, state: ProjectSnapshotState, snapshot: ProjectSnapshot, walked: boolean) {
    const changed = !state.snapshot || !areDeeplyEqual(state.snapshot, snapshot);
    const recovered = state.failure !== null;
    state.failure = null;
    if (walked) {
      state.expiresAt = this.now() + this.cacheTtlMs;
      state.walkedAt = this.now();
    }
    state.lastAccessAt = this.now();
    if (changed) state.serialized = null;
    state.snapshot = snapshot;
    if (changed) state.revision += 1;
    if (changed || recovered) {
      const update = this.toUpdate(snapshot, state.revision);
      for (const observer of state.observers) {
        try { observer.publish(update); }
        catch (error) { this.reportObserverFailure(error); }
      }
    }
    this.evictSnapshots();
  }

  private toUpdate(snapshot: ProjectSnapshot, revision: number): WorkbenchProjectStateUpdate {
    return { projectId: snapshot.projectId, revision, snapshot, updateKind: "project" };
  }

  private stopObservation(state: ProjectSnapshotState) {
    state.observers.clear();
    this.closeTreeWatcher(state);
    state.refreshRequested = false;
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  private stopState(state: ProjectSnapshotState) {
    this.stopObservation(state);
    state.refreshPromise = null;
  }

  private evictSnapshots() {
    while (this.projects.size > this.maxProjectSnapshots) {
      const oldest = [...this.projects.entries()]
        .filter(([, state]) => !state.observers.size)
        .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt)[0];
      if (!oldest) return;
      this.stopState(oldest[1]);
      this.projects.delete(oldest[0]);
    }
  }

  private reportObserverFailure(error: unknown) {
    this.logError(`Project snapshot observer failed: ${(error instanceof Error
      ? error.message : "Unknown observer failure").replace(/[\u0000-\u001f]/gu, "").slice(0, 512)}`);
  }

  private assertActive() {
    if (this.disposed) throw new Error("Project snapshot controller is disposed.");
  }
}
