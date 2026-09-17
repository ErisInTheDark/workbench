/*
 * Exports:
 * - WorkbenchProjectCatalogControllerOptions: injected discovery, resolution, watcher, clock, logging, and TTL controls.
 * - default WorkbenchProjectCatalogController: own catalog discovery, icon assets, snapshot replay, durable CWD resolution, and invalidation.
 */
import fs from "node:fs";
import fileSystem from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

import { discoverProjectIdentities, isPathWithinRoot, normalizeRelativePath, projectsRoot, resolveProjectRootFromProjects } from "./lib/project";
import { discoverWorkbenchProjectIcon } from "./lib/workbench/project/project-icon-discovery";
import type { WorkbenchProjectCacheRecord, WorkbenchProjectPersistence, WorkbenchProjectStartup } from "./database/project/workbench-project-persistence";
import type { ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectOption, WorkbenchProjectsPayload } from "workbench-shared/types";
import {
  resolveAgentEndpointProjectFromProjects,
  type AgentEndpointProjectResolution,
} from "./lib/workbench/project/agent-endpoint-project";
import { logError as defaultLogError } from "./process-helpers";

const DEFAULT_CACHE_TTL_MS = 15_000;
const ICON_FRESHNESS_MS = 5 * 60_000;
const MAX_PROJECT_ICON_BYTES = 4 * 1024 * 1024;
const IGNORED_DISCOVERY_SEGMENTS = new Set([".next", "build", "coverage", "dist", "node_modules"]);

type CatalogCacheState = "coalesced" | "hit" | "miss" | "stale";

interface ProjectWatcher {
  close: () => void;
  on: (event: "error", listener: () => void) => ProjectWatcher;
}

interface ProjectCatalogSnapshot {
  data: WorkbenchProjectOption[];
  payload: WorkbenchProjectsPayload;
  serialized: string;
  records: WorkbenchProjectCacheRecord[];
  excludedRootPaths: string[];
}

type ResolveProjectFromCatalog = (
  projects: readonly WorkbenchProjectOption[],
  cwd: string | null | undefined,
  options?: { endpointName?: string; excludedRootPaths?: readonly string[] },
) => Promise<AgentEndpointProjectResolution>;

type ResolveProjectByIdFromCatalog = typeof resolveProjectRootFromProjects;

export interface WorkbenchProjectCatalogControllerOptions {
  initialProjects?: WorkbenchProjectStartup | (() => WorkbenchProjectStartup);
  persistence: WorkbenchProjectPersistence;
  discoverProjectIdentities?: typeof discoverProjectIdentities;
  discoverIcon?: typeof discoverWorkbenchProjectIcon;
  cacheTtlMs?: number;
  createWatcher?: (rootPath: string, listener: (eventType: string, filename: string | Buffer | null) => void, recursive: boolean) => ProjectWatcher;
  logError?: (message: string) => void;
  now?: () => number;
  projectsRootPath?: string;
  resolveProjectByIdFromCatalog?: ResolveProjectByIdFromCatalog;
  resolveProjectFromCatalog?: ResolveProjectFromCatalog;
}

function sanitizeRefreshError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, "[path]")
    .replace(/\b(Bearer\s+)[^\s,]+/giu, "$1[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500) || "unknown error";
}

function isOwnedCancellation(error: unknown, signal: AbortSignal) {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
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
    || gitPath === "config"
    || gitPath === "packed-refs"
    || gitPath.startsWith("refs/");
}

function shouldInvalidateProjects(eventType: string, filename: string | Buffer | null) {
  const relativePath = normalizeWatchPath(filename);
  if (!relativePath) return true;
  if (hasIgnoredSegment(relativePath, IGNORED_DISCOVERY_SEGMENTS)) return false;
  if (relativePath.split("/").includes(".git")) return isRelevantGitPath(relativePath);
  return eventType === "rename" || relativePath.endsWith(".code-workspace");
}

function sameResolutionInputs(left: readonly WorkbenchProjectOption[], right: readonly WorkbenchProjectOption[]) {
  return left.length === right.length && left.every((project, index) => {
    const other = right[index];
    return project.id === other.id
      && project.kind === other.kind
      && project.relativePath === other.relativePath
      && project.rootPath === other.rootPath
      && project.workspacePath === other.workspacePath
      && project.roots.length === other.roots.length
      && project.roots.every((root, rootIndex) => {
        const otherRoot = other.roots[rootIndex];
        return root.id === otherRoot.id
          && root.name === otherRoot.name
          && root.isPrimary === otherRoot.isPrimary
          && root.relativePath === otherRoot.relativePath
          && root.rootPath === otherRoot.rootPath;
      });
  });
}

function sendSerializedJson(response: http.ServerResponse, statusCode: number, serialized: string, cacheState?: CatalogCacheState) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(serialized),
    "Content-Type": "application/json",
    ...(cacheState ? { "X-Workbench-Snapshot-Cache": cacheState } : {}),
  });
  response.end(serialized);
}

function sendError(response: http.ServerResponse, error: unknown) {
  sendSerializedJson(response, 400, JSON.stringify({
    error: error instanceof Error ? error.message : "Unable to discover projects.",
  }));
}

function sendIconError(response: http.ServerResponse, statusCode: number, error: string) {
  sendSerializedJson(response, statusCode, JSON.stringify({ error }));
}

function projectIconContentType(filePath: string) {
  return filePath.toLocaleLowerCase().endsWith(".ico") ? "image/x-icon" : "image/png";
}

class ProjectIconRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (
    error.code === "ENOENT"
    || error.code === "ENOTDIR"
  ));
}

export default class WorkbenchProjectCatalogController {
  private readonly cancellation = new AbortController();
  private readonly iconWork = new Map<ProjectId, Promise<void>>();
  private readonly persistence: WorkbenchProjectPersistence;
  private readonly loadInitialProjects?: () => WorkbenchProjectStartup;
  private readonly discoverIdentities: typeof discoverProjectIdentities;
  private readonly discoverIcon: typeof discoverWorkbenchProjectIcon;
  private readonly cacheTtlMs: number;
  private catalog: ProjectCatalogSnapshot | null = null;
  private catalogExpiresAt = 0;
  private catalogGeneration = 0;
  private readonly cwdResolutions = new Map<string, Promise<AgentEndpointProjectResolution>>();
  private readonly createWatcher: NonNullable<WorkbenchProjectCatalogControllerOptions["createWatcher"]>;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private hardStale = false;
  private readonly logError: NonNullable<WorkbenchProjectCatalogControllerOptions["logError"]>;
  private readonly now: () => number;
  private refreshInFlight: Promise<ProjectCatalogSnapshot> | null = null;
  private readonly projectsRootPath: string;
  private projectsWatcher: ProjectWatcher | null = null;
  private readonly resolveProjectByIdFromCatalog: ResolveProjectByIdFromCatalog;
  private readonly resolveProjectFromCatalog: ResolveProjectFromCatalog;

  constructor({
    initialProjects,
    persistence,
    discoverProjectIdentities: discoverIdentities = discoverProjectIdentities,
    discoverIcon = discoverWorkbenchProjectIcon,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    createWatcher = defaultCreateWatcher,
    logError = (message) => defaultLogError("project-catalog", message),
    now = Date.now,
    projectsRootPath = projectsRoot,
    resolveProjectByIdFromCatalog = resolveProjectRootFromProjects,
    resolveProjectFromCatalog = resolveAgentEndpointProjectFromProjects,
  }: WorkbenchProjectCatalogControllerOptions) {
    this.persistence = persistence;
    this.discoverIdentities = discoverIdentities;
    this.discoverIcon = discoverIcon;
    this.cacheTtlMs = cacheTtlMs;
    this.createWatcher = createWatcher;
    this.logError = logError;
    this.now = now;
    this.projectsRootPath = projectsRootPath;
    this.resolveProjectByIdFromCatalog = resolveProjectByIdFromCatalog;
    this.resolveProjectFromCatalog = resolveProjectFromCatalog;
    if (typeof initialProjects === "function") this.loadInitialProjects = initialProjects;
    else if (initialProjects) this.installPreparedProjects(initialProjects);
    this.projectsWatcher = this.watchProjects();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.cancellation.abort();
    const work = [...this.iconWork.values(), ...(this.refreshInFlight ? [this.refreshInFlight] : [])];
    this.cwdResolutions.clear();
    this.projectsWatcher?.close();
    this.projectsWatcher = null;
    this.catalog = null;
    this.catalogExpiresAt = 0;
    this.catalogGeneration += 1;
    this.hardStale = true;
    this.disposal = Promise.allSettled(work).then(() => undefined);
    return this.disposal;
  }

  observeProjectIcon(projectId: ProjectId): Promise<void> {
    this.assertActive();
    const pending = this.iconWork.get(projectId);
    if (pending) return pending;
    const record = this.catalog?.records?.find(record => record.project.id === projectId);
    if (!record || record.project.kind === "workbench-library"
      || (record.checkedAt !== null && this.now() - record.checkedAt < ICON_FRESHNESS_MS)) return Promise.resolve();
    const persistence = this.persistence;
    const work = (async () => {
      try {
        const icon = await this.discoverIcon(record.project.roots, this.cancellation.signal);
        if (this.disposed || this.catalog?.records?.find(item => item.project.id === projectId)?.sourceKey !== record.sourceKey) return;
        const checkedAt = this.now();
        const accepted = await persistence.settleProjectIcon({ projectId, sourceKey: record.sourceKey, checkedAt, icon });
        if (!accepted || this.disposed || !this.catalog) return;
        const current = this.catalog.records?.find(item => item.project.id === projectId);
        if (!current || current.sourceKey !== record.sourceKey) return;
        const { icon: _previous, ...metadata } = current.project;
        const project = { ...metadata, ...(icon ? { icon } : {}) };
        const records = this.catalog.records!.map(item => item === current ? { project, sourceKey: current.sourceKey, checkedAt } : item);
        const data = records.map(item => item.project);
        const payload = { ...this.catalog.payload, data };
        this.catalog = { ...this.catalog, records, data, payload, serialized: JSON.stringify(payload) };
      } catch (error) {
        if (!isOwnedCancellation(error, this.cancellation.signal)) this.logError(`project icon refresh failed: ${sanitizeRefreshError(error)}`);
      }
    })();
    this.iconWork.set(projectId, work);
    void work.then(() => { if (this.iconWork.get(projectId) === work) this.iconWork.delete(projectId); });
    return work;
  }

  async handleHttpRequest(_request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const result = await this.readFreshCatalog();
      sendSerializedJson(response, 200, result.catalog.serialized, result.cacheState);
    } catch (error) {
      sendError(response, error);
    }
  }

  async handleIconHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
      const match = /^\/daemon\/project-icons\/([^/]+)$/u.exec(requestPath);
      if (!match) throw new ProjectIconRequestError(400, "Invalid project icon request.");
      let projectId = "";
      try {
        projectId = decodeURIComponent(match[1]);
      } catch {
        throw new ProjectIconRequestError(400, "Invalid project icon request.");
      }
      const { catalog } = await this.readFreshCatalog();
      const project = catalog.data.find((candidate) => candidate.id === projectId);
      const icon = project?.icon;
      const root = icon ? project.roots.find((candidate) => candidate.id === icon.rootId) : null;
      if (!project || !icon || !root) throw new ProjectIconRequestError(404, "Project icon not found.");

      const canonicalRoot = await fileSystem.realpath(root.rootPath);
      const requestedPath = path.resolve(root.rootPath, icon.path);
      const canonicalIcon = await fileSystem.realpath(requestedPath);
      if (!isPathWithinRoot(canonicalIcon, canonicalRoot)) {
        throw new ProjectIconRequestError(404, "Project icon not found.");
      }
      const stats = await fileSystem.stat(canonicalIcon);
      if (!stats.isFile()) throw new ProjectIconRequestError(404, "Project icon not found.");
      if (stats.size > MAX_PROJECT_ICON_BYTES) {
        throw new ProjectIconRequestError(413, "Project icon is too large.");
      }
      const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag });
        response.end();
        return;
      }
      const bytes = await fileSystem.readFile(canonicalIcon);
      if (bytes.byteLength > MAX_PROJECT_ICON_BYTES) {
        throw new ProjectIconRequestError(413, "Project icon is too large.");
      }
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Length": bytes.byteLength,
        "Content-Type": projectIconContentType(icon.path),
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
      });
      response.end(bytes);
    } catch (error) {
      if (error instanceof ProjectIconRequestError) {
        sendIconError(response, error.statusCode, error.message);
        return;
      }
      if (isMissingFileError(error)) {
        sendIconError(response, 404, "Project icon not found.");
        return;
      }
      this.logError(`project icon request failed: ${sanitizeRefreshError(error)}`);
      sendIconError(response, 500, "Unable to read the project icon.");
    }
  }

  async ensureLoaded() {
    this.assertActive();
    if (this.catalog) return;
    await this.refreshCatalog();
  }

  async resolveAgentEndpointProjectFromCwd(
    cwd: string | null | undefined,
    options: { endpointName?: string } = {},
  ) {
    this.assertActive();
    const generation = this.catalogGeneration;
    const { catalog, refresh, refreshed } = await this.readCatalogForResolution();
    this.assertActive();
    const endpointName = options.endpointName ?? "Agent endpoint";
    const key = `${endpointName.length}:${endpointName}${cwd ?? ""}`;
    const cached = generation === this.catalogGeneration ? this.cwdResolutions.get(key) : undefined;
    if (cached) {
      const result = await cached;
      this.assertActive();
      return result;
    }
    const resolution = (async () => {
      let result: AgentEndpointProjectResolution;
      try {
        result = await this.resolveProjectFromCatalog(catalog.data, cwd, { ...options, excludedRootPaths: catalog.excludedRootPaths });
      } catch (firstError) {
        this.assertActive();
        if (refreshed) throw firstError;
        const refreshedCatalog = await (refresh ?? this.refreshCatalog());
        this.assertActive();
        result = await this.resolveProjectFromCatalog(refreshedCatalog.data, cwd, { ...options, excludedRootPaths: refreshedCatalog.excludedRootPaths });
      }
      this.assertActive();
      return result;
    })();
    // Retired callers may finish, but cannot publish into a newer catalog generation.
    if (generation === this.catalogGeneration) this.cwdResolutions.set(key, resolution);
    try {
      return await resolution;
    } catch (error) {
      if (this.cwdResolutions.get(key) === resolution) this.cwdResolutions.delete(key);
      throw error;
    }
  }

  async resolveProjectById(projectId?: string | null) {
    this.assertActive();
    if (projectId) projectId = await this.persistence.resolveProjectIdentity(projectId);
    const { catalog, refresh, refreshed } = await this.readCatalogForResolution();
    try {
      return await this.resolveProjectByIdFromCatalog(catalog.data, projectId);
    } catch (firstError) {
      if (refreshed) throw firstError;
      const refreshedCatalog = await (refresh ?? this.refreshCatalog());
      return await this.resolveProjectByIdFromCatalog(refreshedCatalog.data, projectId);
    }
  }

  getCurrentSnapshot() {
    this.assertActive();
    if (!this.catalog) throw new Error("The project catalog has not been loaded.");
    return this.catalog.payload;
  }

  captureReloadState(): WorkbenchProjectStartup {
    this.assertActive();
    if (!this.catalog?.records) throw new Error("The durable project catalog has not been loaded.");
    return {
      catalog: this.catalog.records,
      aliases: this.catalog.payload.aliases ?? [],
      excludedRootPaths: this.catalog.excludedRootPaths ?? [],
      rootPath: this.catalog.payload.rootPath,
    };
  }

  async readCatalog() {
    return (await this.readFreshCatalog()).catalog.payload;
  }

  invalidate = () => {
    if (this.disposed) return;
    this.catalogExpiresAt = 0;
    this.catalogGeneration += 1;
    this.cwdResolutions.clear();
    this.hardStale = true;
  };

  private async readCatalogForResolution() {
    if (!this.catalog) {
      return { catalog: await this.refreshCatalog(), refresh: null, refreshed: true };
    }
    let refresh: Promise<ProjectCatalogSnapshot> | null = null;
    if (this.hardStale || this.catalogExpiresAt <= this.now()) {
      refresh = this.refreshInBackground();
    }
    return { catalog: this.catalog, refresh, refreshed: false };
  }

  private async readFreshCatalog(): Promise<{ cacheState: CatalogCacheState; catalog: ProjectCatalogSnapshot }> {
    this.assertActive();
    if (this.catalog) {
      if (!this.hardStale && this.catalogExpiresAt > this.now()) {
        return { cacheState: "hit", catalog: this.catalog };
      }
      this.refreshInBackground();
      return { cacheState: "stale", catalog: this.catalog };
    }
    const coalesced = this.refreshInFlight;
    return {
      cacheState: coalesced ? "coalesced" : "miss",
      catalog: await this.refreshCatalog(),
    };
  }

  private refreshCatalog() {
    this.assertActive();
    if (!this.catalog && this.loadInitialProjects) return Promise.resolve(this.installPreparedProjects(this.loadInitialProjects()));
    return this.refreshInFlight ?? this.startRefresh();
  }

  private installPreparedProjects(projects: WorkbenchProjectStartup) {
    const data = projects.catalog.map(record => record.project);
    const payload = { data, aliases: projects.aliases, rootPath: projects.rootPath };
    this.catalog = { data, payload, serialized: JSON.stringify(payload), records: projects.catalog, excludedRootPaths: projects.excludedRootPaths };
    this.catalogExpiresAt = this.now() + this.cacheTtlMs;
    return this.catalog;
  }

  private refreshInBackground() {
    const alreadyRefreshing = Boolean(this.refreshInFlight);
    const refresh = this.refreshCatalog();
    if (!alreadyRefreshing) {
      void refresh.catch((error) => {
        if (isOwnedCancellation(error, this.cancellation.signal)) return;
        this.logError(`project catalog background refresh failed: ${sanitizeRefreshError(error)}`);
      });
    }
    return refresh;
  }

  private startRefresh() {
    const generation = this.catalogGeneration;
    const refresh = (async () => {
      const discovery = await this.discoverIdentities(this.cancellation.signal);
      this.cancellation.signal.throwIfAborted();
      if (this.catalogGeneration !== generation && this.catalog) return this.catalog;
      const reconciled = await this.persistence.reconcileProjectCatalog(discovery);
      let records = reconciled.catalog;
      const aliases = reconciled.aliases;
      // A database reply can precede an icon settlement but arrive at publication after it.
      records = records.map(record => {
        const current = this.catalog?.records?.find(item => item.project.id === record.project.id);
        if (!current || current.sourceKey !== record.sourceKey || current.checkedAt === null
          || (record.checkedAt !== null && record.checkedAt >= current.checkedAt)) return record;
        const { icon: _old, ...metadata } = record.project;
        return { ...record, checkedAt: current.checkedAt, project: { ...metadata, ...(current.project.icon ? { icon: current.project.icon } : {}) } };
      });
      const data = records.map(record => record.project);
      const payload: WorkbenchProjectsPayload = {
        data,
        aliases,
        rootPath: normalizeRelativePath(this.projectsRootPath),
      };
      const catalog = { data, payload, serialized: JSON.stringify(payload), records, excludedRootPaths: reconciled.excludedRootPaths };
      if (!this.disposed && this.catalogGeneration === generation) {
        if (this.catalog && (!sameResolutionInputs(this.catalog.data, data)
          || (this.catalog.excludedRootPaths?.length ?? 0) !== (catalog.excludedRootPaths?.length ?? 0)
          || this.catalog.excludedRootPaths?.some(root => !catalog.excludedRootPaths?.includes(root)))) {
          this.cwdResolutions.clear();
          this.catalogGeneration += 1;
        }
        this.catalog = catalog;
        this.catalogExpiresAt = this.now() + this.cacheTtlMs;
        this.hardStale = false;
      }
      return catalog;
    })();
    this.refreshInFlight = refresh;
    void refresh.finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }).catch(() => undefined);
    return refresh;
  }

  private watchProjects() {
    try {
      const watcher = this.createWatcher(this.projectsRootPath, (eventType, filename) => {
        if (shouldInvalidateProjects(eventType, filename)) this.invalidate();
      }, false);
      watcher.on("error", this.invalidate);
      return watcher;
    } catch {
      this.invalidate();
      return null;
    }
  }

  private assertActive() {
    if (this.disposed) throw new Error("Project catalog controller is disposed.");
  }
}
