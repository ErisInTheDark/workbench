/*
 * Exports:
 * - WorkbenchProjectSnapshotControllerOptions: injected project operations, watcher factory, clock, TTL, and cache bound for deterministic lifecycle tests. Keywords: project, snapshot, cache, watcher, test.
 * - default WorkbenchProjectSnapshotController: own bounded serialized project payloads, request coalescing, filesystem invalidation, HTTP adaptation, and disposal. Keywords: project, tree, cache, orchestrator, watcher, lifecycle.
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import {
  assertProjectFileCanBeDeleted,
  createProjectEntry,
  deleteProjectFile,
  discoverProjects,
  formatWorkspaceQualifiedPath,
  getProjectSnapshot,
  normalizeRelativePath,
  projectsRoot,
  resolveProjectFilePath,
  resolveProjectRoot,
} from "../lib/project";
import { isGitTrackedFile } from "../lib/git";
import type { ProjectSnapshot, WorkbenchProjectsPayload } from "../lib/types";

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_PROJECT_SNAPSHOTS = 4;
const IGNORED_TREE_SEGMENTS = new Set([".codex", ".next", ".vscode", ".workbench", "node_modules"]);
const IGNORED_DISCOVERY_SEGMENTS = new Set([".next", "build", "coverage", "dist", "node_modules"]);

type SnapshotCacheState = "coalesced" | "hit" | "miss";

interface ProjectWatcher {
  close: () => void;
  on: (event: "error", listener: () => void) => ProjectWatcher;
}

interface SnapshotCacheEntry {
  expiresAt: number;
  generation: number;
  lastAccessAt: number;
  rootPaths: string[];
  serialized: string | null;
  watchers: ProjectWatcher[];
}

interface SnapshotBuildResult {
  snapshot: ProjectSnapshot;
  serialized: string;
}

interface SnapshotResponse {
  cacheState: SnapshotCacheState;
  snapshot: ProjectSnapshot | null;
  serialized: string;
}

type ProjectOperations = {
  assertProjectFileCanBeDeleted: typeof assertProjectFileCanBeDeleted;
  createProjectEntry: typeof createProjectEntry;
  deleteProjectFile: typeof deleteProjectFile;
  discoverProjects: typeof discoverProjects;
  getProjectSnapshot: typeof getProjectSnapshot;
  isGitTrackedFile: typeof isGitTrackedFile;
  resolveProjectFilePath: typeof resolveProjectFilePath;
  resolveProjectRoot: typeof resolveProjectRoot;
};

export interface WorkbenchProjectSnapshotControllerOptions {
  cacheTtlMs?: number;
  createWatcher?: (rootPath: string, listener: (eventType: string, filename: string | Buffer | null) => void, recursive: boolean) => ProjectWatcher;
  maxProjectSnapshots?: number;
  now?: () => number;
  operations?: ProjectOperations;
  projectsRootPath?: string;
}

function defaultCreateWatcher(rootPath: string, listener: (eventType: string, filename: string | Buffer | null) => void, recursive: boolean) {
  return fs.watch(rootPath, { recursive }, listener);
}

function normalizeWatchPath(filename: string | Buffer | null) {
  return normalizeRelativePath(Buffer.isBuffer(filename) ? filename.toString("utf8") : filename ?? "")
    .replace(/^\/+|\/+$/gu, "");
}

function hasIgnoredSegment(relativePath: string, ignoredSegments: ReadonlySet<string>) {
  return relativePath.split("/").some((segment) => ignoredSegments.has(segment));
}

function isRelevantGitPath(relativePath: string) {
  const segments = relativePath.split("/");
  const gitIndex = segments.indexOf(".git");
  if (gitIndex < 0) return false;
  const gitPath = segments.slice(gitIndex + 1).join("/");
  return !gitPath
    || gitPath === "HEAD"
    || gitPath === "index"
    || gitPath === "packed-refs"
    || gitPath.startsWith("refs/");
}

function shouldInvalidateTree(filename: string | Buffer | null) {
  const relativePath = normalizeWatchPath(filename);
  if (!relativePath) return true;
  if (relativePath.split("/").includes(".git")) return isRelevantGitPath(relativePath);
  return !hasIgnoredSegment(relativePath, IGNORED_TREE_SEGMENTS);
}

function shouldInvalidateProjects(eventType: string, filename: string | Buffer | null) {
  const relativePath = normalizeWatchPath(filename);
  if (!relativePath) return true;
  if (hasIgnoredSegment(relativePath, IGNORED_DISCOVERY_SEGMENTS)) return false;
  if (relativePath.split("/").includes(".git")) return isRelevantGitPath(relativePath);
  return eventType === "rename" || relativePath.endsWith(".code-workspace");
}

function haveSameRootPaths(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
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
  sendSerializedJson(response, 400, JSON.stringify({
    error: error instanceof Error ? error.message : fallback,
  }));
}

export default class WorkbenchProjectSnapshotController {
  private readonly cacheTtlMs: number;
  private readonly createWatcher: NonNullable<WorkbenchProjectSnapshotControllerOptions["createWatcher"]>;
  private disposed = false;
  private readonly inFlightSnapshots = new Map<string, Promise<SnapshotBuildResult>>();
  private readonly maxProjectSnapshots: number;
  private readonly now: () => number;
  private readonly operations: ProjectOperations;
  private projectsCache: { expiresAt: number; generation: number; serialized: string | null } = {
    expiresAt: 0,
    generation: 0,
    serialized: null,
  };
  private projectsInFlight: Promise<string> | null = null;
  private projectsWatcher: ProjectWatcher | null = null;
  private readonly projectsRootPath: string;
  private readonly snapshots = new Map<string, SnapshotCacheEntry>();

  constructor({
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    createWatcher = defaultCreateWatcher,
    maxProjectSnapshots = DEFAULT_MAX_PROJECT_SNAPSHOTS,
    now = Date.now,
    operations = { assertProjectFileCanBeDeleted, createProjectEntry, deleteProjectFile, discoverProjects, getProjectSnapshot, isGitTrackedFile, resolveProjectFilePath, resolveProjectRoot },
    projectsRootPath = projectsRoot,
  }: WorkbenchProjectSnapshotControllerOptions = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.createWatcher = createWatcher;
    this.maxProjectSnapshots = Math.max(1, Math.trunc(maxProjectSnapshots));
    this.now = now;
    this.operations = operations;
    this.projectsRootPath = projectsRootPath;
    this.projectsWatcher = this.watch(this.projectsRootPath, (eventType, filename) => {
      if (shouldInvalidateProjects(eventType, filename)) this.invalidateProjects();
    }, this.invalidateProjects, false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.projectsWatcher?.close();
    this.projectsWatcher = null;
    for (const entry of this.snapshots.values()) this.closeWatchers(entry.watchers);
    this.snapshots.clear();
    this.inFlightSnapshots.clear();
    this.projectsInFlight = null;
    this.projectsCache = { expiresAt: 0, generation: this.projectsCache.generation + 1, serialized: null };
  }

  async handleProjectsHttpRequest(_request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const result = await this.readProjects();
      sendSerializedJson(response, 200, result.serialized, result.cacheState);
    } catch (error) {
      sendError(response, error, "Unable to discover projects.");
    }
  }

  async handleTreeHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET") {
        const result = await this.readSnapshot(requestUrl.searchParams.get("projectId"));
        sendSerializedJson(response, 200, result.serialized, result.cacheState);
        return;
      }
      if (request.method === "DELETE") {
        const value = JSON.parse(await readRequestBody(request)) as { confirmUntracked?: boolean; path?: string; projectId?: string };
        if (!value.path) {
          sendSerializedJson(response, 400, JSON.stringify({ error: "A file path is required." }));
          return;
        }
        const resolvedProject = await this.operations.resolveProjectRoot(value.projectId ?? null);
        const resolvedFile = this.operations.resolveProjectFilePath(resolvedProject, value.path);
        await this.operations.assertProjectFileCanBeDeleted(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
        const tracked = await this.operations.isGitTrackedFile(resolvedFile.gitRoot, resolvedFile.rootRelativePath);
        if (!tracked && value.confirmUntracked !== true) {
          sendSerializedJson(response, 409, JSON.stringify({
            confirmationRequired: true,
            path: resolvedFile.displayPath,
            projectId: resolvedProject.id,
            tracked: false,
          }));
          return;
        }

        await this.operations.deleteProjectFile(resolvedFile.rootRelativePath, resolvedFile.gitRoot);
        this.invalidateSnapshot(resolvedProject.id);
        this.invalidateSnapshot("__default__");
        const result = await this.readSnapshot(resolvedProject.id);
        if (!result.snapshot) throw new Error("Project tree refresh did not produce a snapshot.");
        sendSerializedJson(response, 200, JSON.stringify({
          ...result.snapshot,
          path: resolvedFile.displayPath,
          tracked,
        }), result.cacheState);
        return;
      }
      if (request.method !== "POST") {
        sendSerializedJson(response, 405, JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const value = JSON.parse(await readRequestBody(request)) as { name?: string; parentPath?: string; projectId?: string; type?: string };
      if (value.type !== "file" && value.type !== "directory") {
        sendSerializedJson(response, 400, JSON.stringify({ error: "A valid entry type is required." }));
        return;
      }
      const resolvedProject = await this.operations.resolveProjectRoot(value.projectId ?? null);
      const resolvedParent = this.operations.resolveProjectFilePath(resolvedProject, value.parentPath ?? "");
      const createdRootPath = await this.operations.createProjectEntry(resolvedParent.rootRelativePath, value.name ?? "", value.type, resolvedParent.gitRoot);
      const createdPath = resolvedProject.kind === "workspace"
        ? formatWorkspaceQualifiedPath(resolvedParent.root.id, createdRootPath)
        : createdRootPath;
      this.invalidateSnapshot(resolvedProject.id);
      this.invalidateSnapshot("__default__");
      const result = await this.readSnapshot(resolvedProject.id);
      if (!result.snapshot) throw new Error("Project tree refresh did not produce a snapshot.");
      sendSerializedJson(response, 200, JSON.stringify({
        ...result.snapshot,
        path: createdPath,
        type: value.type,
      }), result.cacheState);
    } catch (error) {
      sendError(response, error, "Unable to update project tree.");
    }
  }

  invalidateProjects = () => {
    this.projectsCache = {
      expiresAt: 0,
      generation: this.projectsCache.generation + 1,
      serialized: null,
    };
  };

  invalidateSnapshot(projectId: string) {
    const entry = this.snapshots.get(projectId);
    if (!entry) return;
    entry.expiresAt = 0;
    entry.generation += 1;
    entry.serialized = null;
  }

  private async readProjects() {
    this.assertActive();
    const now = this.now();
    if (this.projectsCache.serialized && this.projectsCache.expiresAt > now) {
      return { cacheState: "hit" as const, serialized: this.projectsCache.serialized };
    }
    if (this.projectsInFlight) {
      return { cacheState: "coalesced" as const, serialized: await this.projectsInFlight };
    }
    const generation = this.projectsCache.generation;
    const promise = (async () => {
      const payload: WorkbenchProjectsPayload = {
        data: await this.operations.discoverProjects(),
        rootPath: normalizeRelativePath(this.projectsRootPath),
      };
      const serialized = JSON.stringify(payload);
      if (!this.disposed && this.projectsCache.generation === generation) {
        this.projectsCache = { expiresAt: this.now() + this.cacheTtlMs, generation, serialized };
      }
      return serialized;
    })();
    this.projectsInFlight = promise;
    try {
      return { cacheState: "miss" as const, serialized: await promise };
    } finally {
      if (this.projectsInFlight === promise) this.projectsInFlight = null;
    }
  }

  private async readSnapshot(projectId: string | null): Promise<SnapshotResponse> {
    this.assertActive();
    const key = projectId?.trim() || "__default__";
    const existing = this.snapshots.get(key);
    const now = this.now();
    if (existing?.serialized && existing.expiresAt > now) {
      existing.lastAccessAt = now;
      return { cacheState: "hit", serialized: existing.serialized, snapshot: null };
    }
    const coalesced = this.inFlightSnapshots.get(key);
    if (coalesced) {
      return { cacheState: "coalesced", ...await coalesced };
    }
    const generation = existing?.generation ?? 0;
    const promise = this.buildSnapshot(key, projectId, generation);
    this.inFlightSnapshots.set(key, promise);
    try {
      return { cacheState: "miss", ...await promise };
    } finally {
      if (this.inFlightSnapshots.get(key) === promise) this.inFlightSnapshots.delete(key);
    }
  }

  private async buildSnapshot(key: string, projectId: string | null, generation: number): Promise<SnapshotBuildResult> {
    const snapshot = await this.operations.getProjectSnapshot(projectId);
    const serialized = JSON.stringify(snapshot);
    if (!this.disposed && (this.snapshots.get(key)?.generation ?? 0) === generation) {
      this.installSnapshot(key, snapshot, serialized, generation);
    }
    return { serialized, snapshot };
  }

  private installSnapshot(key: string, snapshot: ProjectSnapshot, serialized: string, generation: number) {
    const rootPaths = snapshot.roots.map((root) => path.resolve(root.rootPath));
    const existing = this.snapshots.get(key);
    const watchers = existing && haveSameRootPaths(existing.rootPaths, rootPaths)
      ? existing.watchers
      : this.createSnapshotWatchers(key, rootPaths, existing?.watchers ?? []);
    this.snapshots.set(key, {
      expiresAt: this.now() + this.cacheTtlMs,
      generation,
      lastAccessAt: this.now(),
      rootPaths,
      serialized,
      watchers,
    });
    this.evictSnapshots();
  }

  private createSnapshotWatchers(key: string, rootPaths: string[], previousWatchers: ProjectWatcher[]) {
    this.closeWatchers(previousWatchers);
    return rootPaths.flatMap((rootPath) => {
      const watcher = this.watch(rootPath, (_eventType, filename) => {
        if (shouldInvalidateTree(filename)) this.invalidateSnapshot(key);
      }, () => this.invalidateSnapshot(key), true);
      return watcher ? [watcher] : [];
    });
  }

  private watch(
    rootPath: string,
    onChange: (eventType: string, filename: string | Buffer | null) => void,
    onError: () => void,
    recursive: boolean,
  ) {
    try {
      const watcher = this.createWatcher(rootPath, onChange, recursive);
      watcher.on("error", onError);
      return watcher;
    } catch {
      onError();
      return null;
    }
  }

  private evictSnapshots() {
    while (this.snapshots.size > this.maxProjectSnapshots) {
      const oldest = [...this.snapshots.entries()].sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt)[0];
      if (!oldest) return;
      this.closeWatchers(oldest[1].watchers);
      this.snapshots.delete(oldest[0]);
    }
  }

  private closeWatchers(watchers: readonly ProjectWatcher[]) {
    for (const watcher of watchers) watcher.close();
  }

  private assertActive() {
    if (this.disposed) throw new Error("Project snapshot controller is disposed.");
  }
}
