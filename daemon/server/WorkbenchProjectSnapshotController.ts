/*
 * Exports:
 * - WorkbenchProjectSnapshotControllerOptions: injected project resolution, tree operations, clock, polling, logging, and cache bound for deterministic lifecycle tests.
 * - default WorkbenchProjectSnapshotController: own one reloadable snapshot loop per observed project, mutations, change-only publication, HTTP compatibility, and disposal.
 */
import type http from "node:http";

import {
  assertProjectFileCanBeDeleted,
  createProjectEntry,
  deleteProjectFile,
  formatWorkspaceQualifiedPath,
  getProjectSnapshotFromResolvedProject,
  resolveProjectFilePath,
  type ResolvedProject,
} from "./lib/project";
import { isGitTrackedFile } from "./lib/git";
import type { CreateEntryPayload, DeleteFileResponse, ProjectSnapshot } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkbenchProjectStateRequest, WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_PROJECT_SNAPSHOTS = 4;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

type SnapshotCacheState = "coalesced" | "hit" | "miss";

interface ProjectSnapshotState {
  expiresAt: number;
  failureReported: boolean;
  lastAccessAt: number;
  observationToken: symbol | null;
  observed: boolean;
  publish: ((update: WorkbenchProjectStateUpdate) => void) | null;
  refreshPromise: Promise<ProjectSnapshot | null> | null;
  refreshRequested: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  revision: number;
  serialized: string | null;
  snapshot: ProjectSnapshot | null;
}

interface SnapshotResponse {
  cacheState: SnapshotCacheState;
  snapshot: ProjectSnapshot;
  serialized: string;
}

type ProjectOperations = {
  assertProjectFileCanBeDeleted: typeof assertProjectFileCanBeDeleted;
  createProjectEntry: typeof createProjectEntry;
  deleteProjectFile: typeof deleteProjectFile;
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
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
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

  constructor({
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    logError = (message) => console.error(message),
    maxProjectSnapshots = DEFAULT_MAX_PROJECT_SNAPSHOTS,
    now = Date.now,
    operations = { assertProjectFileCanBeDeleted, createProjectEntry, deleteProjectFile, getProjectSnapshot: getProjectSnapshotFromResolvedProject, isGitTrackedFile, resolveProjectFilePath },
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    resolveProjectById,
    observeProject = () => undefined,
  }: WorkbenchProjectSnapshotControllerOptions) {
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

  observe(projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void) {
    this.assertActive();
    this.observeProject(projectId);
    const key = this.projectKey(projectId);
    const state = this.getState(key);
    const observationToken = Symbol(projectId);
    state.lastAccessAt = this.now();
    state.observationToken = observationToken;
    state.observed = true;
    state.publish = publish;
    if (state.snapshot) publish(this.toUpdate(state.snapshot, state.revision));
    this.scheduleRefresh(key, projectId, 0);
    return () => {
      if (state.observationToken !== observationToken) return;
      this.stopObservation(state);
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
      this.scheduleRefresh(this.projectKey(projectId), projectId, 0);
      return { accepted: true };
    }
    if (request.method === "workbench/thread-state/project/entry/create") return await this.createEntry(request);
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
      const value = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      const projectId = typeof value.projectId === "string" ? value.projectId : "";
      if (request.method === "POST") {
        const result = await this.createEntry({
          method: "workbench/thread-state/project/entry/create",
          name: typeof value.name === "string" ? value.name : "",
          parentPath: typeof value.parentPath === "string" ? value.parentPath : "",
          projectId,
          type: value.type === "directory" ? "directory" : "file",
        });
        const snapshot = await this.readSnapshot(projectId);
        sendSerializedJson(response, 200, JSON.stringify({ ...snapshot.snapshot, ...result }), snapshot.cacheState);
        return;
      }
      if (request.method === "DELETE") {
        const result = await this.deleteFile({
          confirmUntracked: value.confirmUntracked === true,
          method: "workbench/thread-state/project/file/delete",
          path: typeof value.path === "string" ? value.path : "",
          projectId,
        });
        if (result.confirmationRequired) {
          sendSerializedJson(response, 409, JSON.stringify(result));
          return;
        }
        const snapshot = await this.readSnapshot(projectId);
        sendSerializedJson(response, 200, JSON.stringify({ ...snapshot.snapshot, ...result }), snapshot.cacheState);
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

  private async createEntry(request: Extract<WorkbenchProjectStateRequest, { method: "workbench/thread-state/project/entry/create" }>): Promise<CreateEntryPayload> {
    const resolvedProject = await this.resolveProjectById(request.projectId);
    const resolvedParent = this.operations.resolveProjectFilePath(resolvedProject, request.parentPath);
    const createdRootPath = await this.operations.createProjectEntry(resolvedParent.rootRelativePath, request.name, request.type, resolvedParent.gitRoot);
    const createdPath = resolvedProject.kind === "workspace"
      ? formatWorkspaceQualifiedPath(resolvedParent.root.id, createdRootPath)
      : createdRootPath;
    this.invalidateSnapshot(resolvedProject.id);
    this.invalidateSnapshot("__default__");
    await this.refreshNow(this.projectKey(resolvedProject.id), resolvedProject.id);
    return { path: createdPath, type: request.type };
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
      failureReported: false,
      lastAccessAt: this.now(),
      observationToken: null,
      observed: false,
      publish: null,
      refreshPromise: null,
      refreshRequested: false,
      refreshTimer: null,
      revision: 0,
      serialized: null,
      snapshot: null,
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
    if (state.snapshot && state.serialized && state.expiresAt > now) {
      return { cacheState: "hit", serialized: state.serialized, snapshot: state.snapshot };
    }
    const cacheState: SnapshotCacheState = state.refreshPromise ? "coalesced" : "miss";
    await this.refreshNow(key, projectId);
    if (!state.snapshot || !state.serialized) throw new Error("Project tree refresh did not produce a snapshot.");
    return { cacheState, serialized: state.serialized, snapshot: state.snapshot };
  }

  private scheduleRefresh(key: string, projectId: string | null, delayMs: number) {
    const state = this.projects.get(key);
    if (!state?.observed || this.disposed) return;
    if (state.refreshPromise) {
      state.refreshRequested = true;
      return;
    }
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void this.refreshNow(key, projectId);
    }, delayMs);
    state.refreshTimer.unref?.();
  }

  private async refreshNow(key: string, projectId: string | null) {
    const state = this.getState(key);
    if (state.refreshPromise) {
      state.refreshRequested = true;
      return await state.refreshPromise;
    }
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.refreshRequested = false;
    const promise = this.resolveProjectById(projectId).then((project) => (
      this.operations.getProjectSnapshot(project)
    )).then((snapshot) => {
      if (this.disposed) return null;
      this.installSnapshot(key, state, snapshot);
      state.failureReported = false;
      return snapshot;
    }).catch((error: unknown) => {
      if (!state.failureReported) {
        state.failureReported = true;
        this.logError(`Project snapshot refresh failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }).finally(() => {
      state.refreshPromise = null;
      if (!state.observed || this.disposed) return;
      const delay = state.refreshRequested ? 0 : this.pollIntervalMs;
      state.refreshRequested = false;
      this.scheduleRefresh(key, projectId, delay);
    });
    state.refreshPromise = promise;
    return await promise;
  }

  private installSnapshot(key: string, state: ProjectSnapshotState, snapshot: ProjectSnapshot) {
    const changed = !state.snapshot || !areDeeplyEqual(state.snapshot, snapshot);
    state.expiresAt = this.now() + this.cacheTtlMs;
    state.lastAccessAt = this.now();
    state.serialized = JSON.stringify(snapshot);
    state.snapshot = snapshot;
    if (changed) {
      state.revision += 1;
      state.publish?.(this.toUpdate(snapshot, state.revision));
    }
    this.evictSnapshots();
  }

  private toUpdate(snapshot: ProjectSnapshot, revision: number): WorkbenchProjectStateUpdate {
    return { projectId: snapshot.projectId, revision, snapshot, updateKind: "project" };
  }

  private stopObservation(state: ProjectSnapshotState) {
    state.observationToken = null;
    state.observed = false;
    state.publish = null;
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
        .filter(([, state]) => !state.observed)
        .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt)[0];
      if (!oldest) return;
      this.stopState(oldest[1]);
      this.projects.delete(oldest[0]);
    }
  }

  private assertActive() {
    if (this.disposed) throw new Error("Project snapshot controller is disposed.");
  }
}
