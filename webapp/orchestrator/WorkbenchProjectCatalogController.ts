/*
 * Exports:
 * - WorkbenchProjectCatalogControllerOptions: injected project discovery, resolution, watcher, clock, logging, and TTL controls. Keywords: project, catalog, cache, watcher, test.
 * - default WorkbenchProjectCatalogController: own the structured project catalog, JIT snapshot replay, serialized HTTP payload, coalesced refresh, CWD resolution, and invalidation lifecycle. Keywords: project, catalog, cwd, cache, orchestrator.
 */
import fs from "node:fs";
import type http from "node:http";

import { discoverProjects, normalizeRelativePath, projectsRoot, resolveProjectRootFromProjects } from "../lib/project";
import type { WorkbenchProjectOption, WorkbenchProjectsPayload } from "../lib/types";
import {
  resolveAgentEndpointProjectFromProjects,
  type AgentEndpointProjectResolution,
} from "../lib/workbench/project/agent-endpoint-project";
import { logError as defaultLogError } from "./process-helpers";

const DEFAULT_CACHE_TTL_MS = 15_000;
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
}

type ResolveProjectFromCatalog = (
  projects: readonly WorkbenchProjectOption[],
  cwd: string | null | undefined,
  options?: { endpointName?: string },
) => Promise<AgentEndpointProjectResolution>;

type ResolveProjectByIdFromCatalog = typeof resolveProjectRootFromProjects;

export interface WorkbenchProjectCatalogControllerOptions {
  cacheTtlMs?: number;
  createWatcher?: (rootPath: string, listener: (eventType: string, filename: string | Buffer | null) => void, recursive: boolean) => ProjectWatcher;
  discoverProjects?: typeof discoverProjects;
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

function shouldInvalidateProjects(eventType: string, filename: string | Buffer | null) {
  const relativePath = normalizeWatchPath(filename);
  if (!relativePath) return true;
  if (hasIgnoredSegment(relativePath, IGNORED_DISCOVERY_SEGMENTS)) return false;
  if (relativePath.split("/").includes(".git")) return isRelevantGitPath(relativePath);
  return eventType === "rename" || relativePath.endsWith(".code-workspace");
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

export default class WorkbenchProjectCatalogController {
  private readonly cacheTtlMs: number;
  private catalog: ProjectCatalogSnapshot | null = null;
  private catalogExpiresAt = 0;
  private catalogGeneration = 0;
  private readonly createWatcher: NonNullable<WorkbenchProjectCatalogControllerOptions["createWatcher"]>;
  private readonly discoverProjectOptions: typeof discoverProjects;
  private disposed = false;
  private hardStale = false;
  private readonly logError: NonNullable<WorkbenchProjectCatalogControllerOptions["logError"]>;
  private readonly now: () => number;
  private refreshInFlight: Promise<ProjectCatalogSnapshot> | null = null;
  private readonly projectsRootPath: string;
  private projectsWatcher: ProjectWatcher | null = null;
  private readonly resolveProjectByIdFromCatalog: ResolveProjectByIdFromCatalog;
  private readonly resolveProjectFromCatalog: ResolveProjectFromCatalog;

  constructor({
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    createWatcher = defaultCreateWatcher,
    discoverProjects: discoverProjectOptions = discoverProjects,
    logError = (message) => defaultLogError("project-catalog", message),
    now = Date.now,
    projectsRootPath = projectsRoot,
    resolveProjectByIdFromCatalog = resolveProjectRootFromProjects,
    resolveProjectFromCatalog = resolveAgentEndpointProjectFromProjects,
  }: WorkbenchProjectCatalogControllerOptions = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.createWatcher = createWatcher;
    this.discoverProjectOptions = discoverProjectOptions;
    this.logError = logError;
    this.now = now;
    this.projectsRootPath = projectsRootPath;
    this.resolveProjectByIdFromCatalog = resolveProjectByIdFromCatalog;
    this.resolveProjectFromCatalog = resolveProjectFromCatalog;
    this.projectsWatcher = this.watchProjects();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.projectsWatcher?.close();
    this.projectsWatcher = null;
    this.catalog = null;
    this.catalogExpiresAt = 0;
    this.catalogGeneration += 1;
    this.hardStale = true;
    this.refreshInFlight = null;
  }

  async handleHttpRequest(_request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const result = await this.readFreshCatalog();
      sendSerializedJson(response, 200, result.catalog.serialized, result.cacheState);
    } catch (error) {
      sendError(response, error);
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
    const { catalog, refresh, refreshed } = await this.readCatalogForResolution();
    try {
      return await this.resolveProjectFromCatalog(catalog.data, cwd, options);
    } catch (firstError) {
      if (refreshed) throw firstError;
      const refreshedCatalog = await (refresh ?? this.refreshCatalog());
      return await this.resolveProjectFromCatalog(refreshedCatalog.data, cwd, options);
    }
  }

  async resolveProjectById(projectId?: string | null) {
    this.assertActive();
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

  invalidate = () => {
    if (this.disposed) return;
    this.catalogExpiresAt = 0;
    this.catalogGeneration += 1;
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

  private async refreshCatalog() {
    this.assertActive();
    return await (this.refreshInFlight ?? this.startRefresh());
  }

  private refreshInBackground() {
    const alreadyRefreshing = Boolean(this.refreshInFlight);
    const refresh = this.refreshCatalog();
    if (!alreadyRefreshing) {
      void refresh.catch((error) => {
        this.logError(`project catalog background refresh failed: ${sanitizeRefreshError(error)}`);
      });
    }
    return refresh;
  }

  private startRefresh() {
    const generation = this.catalogGeneration;
    const refresh = (async () => {
      const data = await this.discoverProjectOptions();
      const payload: WorkbenchProjectsPayload = {
        data,
        rootPath: normalizeRelativePath(this.projectsRootPath),
      };
      const catalog = { data, payload, serialized: JSON.stringify(payload) };
      if (!this.disposed && this.catalogGeneration === generation) {
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
