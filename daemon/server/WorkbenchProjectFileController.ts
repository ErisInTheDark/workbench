/*
 * Exports:
 * - ProjectFileFact: observed disk contents, freshness and scoped failure.
 * - ProjectFileObservationOptions: injectable reads and watches for deterministic observation lifecycles.
 * - default WorkbenchProjectFileController: own file reads, writes, conflicts and demand-scoped disk observations.
 */
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

import { getHeadFileContent, getGitChanges } from "./lib/git";
import { resolveProjectFilePath } from "./lib/project";
import type { ChangeSummary, SaveConflictPayload } from "workbench-shared/types";
import { isEnvironmentFile, isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type { ProjectFileSnapshot } from "workbench-shared/workbench/project/project-file";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import watchGitRefs from "./lib/workbench/git/git-ref-watch";

export interface ProjectFileFact {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  data: ProjectFileSnapshot | null;
}

export interface ProjectFileObservationOptions {
  read?: (projectId: string, filePath: string) => Promise<ProjectFileSnapshot>;
  watch?: (projectId: string, filePath: string, changed: () => void,
    failed: (error: Error) => void) => Promise<() => void>;
}

interface FileInterest {
  projectId: string;
  path: string;
  listeners: Set<() => void>;
  fact: ProjectFileFact;
  running: boolean;
  dirty: boolean;
  stop: (() => void) | null;
  watchFailure: string | null;
}

function failureMessage(error: unknown) {
  return (error instanceof Error ? error.message : "File observation failed.")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

function isEditableFile(filePath: string) {
  return isWorkbenchOpenableFile(filePath) || isEnvironmentFile(filePath);
}

export default class WorkbenchProjectFileController {
  private readonly interests = new Map<string, FileInterest>();
  private disposed = false;

  constructor(
    private readonly catalog: Pick<WorkbenchProjectCatalogController, "resolveProjectById">,
    private readonly snapshots: {
      refreshAfterFileMutation(projectId: string): Promise<{ changes: Record<string, ChangeSummary> }>;
    },
    private readonly observation: ProjectFileObservationOptions = {},
  ) {}

  observe(projectId: string, filePath: string, listener: () => void) {
    if (this.disposed) throw new Error("File observations are reloading.");
    const key = JSON.stringify([projectId, filePath]);
    let interest = this.interests.get(key);
    if (!interest) {
      interest = {
        projectId, path: filePath, listeners: new Set(),
        fact: { phase: "pending", failure: null, data: null },
        running: false, dirty: false, stop: null, watchFailure: null,
      };
      this.interests.set(key, interest);
      const created = interest;
      const changed = () => this.refresh(key, created);
      const failed = (error: Error) => {
        if (!this.active(key, created)) return;
        created.watchFailure = failureMessage(error);
        this.publish(created, { ...created.fact, phase: created.fact.data ? "stale" : "failed",
          failure: created.watchFailure });
      };
      void (this.observation.watch ?? this.watchFile.bind(this))(projectId, filePath, changed, failed)
        .then(stop => {
          if (this.active(key, created)) created.stop = stop;
          else stop();
        }).catch(failed).finally(changed);
    }
    const owned = interest;
    const notify = () => listener();
    owned.listeners.add(notify);
    return {
      read: () => owned.fact,
      release: () => {
        if (!owned.listeners.delete(notify)) return;
        if (owned.listeners.size || this.interests.get(key) !== owned) return;
        this.interests.delete(key);
        owned.stop?.();
      },
    };
  }

  dispose() {
    this.disposed = true;
    for (const interest of this.interests.values()) interest.stop?.();
    this.interests.clear();
  }

  private active(key: string, interest: FileInterest) {
    return !this.disposed && this.interests.get(key) === interest;
  }

  private refresh(key: string, interest: FileInterest) {
    if (!this.active(key, interest)) return;
    interest.dirty = true;
    if (interest.running) return;
    interest.running = true;
    void this.readInterest(key, interest);
  }

  private async readInterest(key: string, interest: FileInterest) {
    try {
      do {
        interest.dirty = false;
        let next: ProjectFileFact;
        try {
          const data = await (this.observation.read ?? this.readObservedFile.bind(this))(interest.projectId, interest.path);
          next = { phase: interest.watchFailure ? "stale" : "current", failure: interest.watchFailure, data };
        } catch (error) {
          next = { phase: interest.fact.data ? "stale" : "failed",
            failure: failureMessage(error), data: interest.fact.data };
        }
        if (!this.active(key, interest)) return;
        if (!interest.dirty) this.publish(interest, next);
      } while (interest.dirty);
    } finally {
      interest.running = false;
    }
  }

  private publish(interest: FileInterest, fact: ProjectFileFact) {
    if (areDeeplyEqual(interest.fact, fact)) return;
    interest.fact = fact;
    for (const listener of interest.listeners) listener();
  }

  private async readObservedFile(projectId: string, filePath: string): Promise<ProjectFileSnapshot> {
    const project = await this.catalog.resolveProjectById(projectId);
    const file = resolveProjectFilePath(project, filePath);
    const [payload, changes] = await Promise.all([
      this.read({ projectId, path: filePath }), getGitChanges(file.gitRoot),
    ]);
    return { ...payload, changeSummary: changes[file.rootRelativePath] ?? null };
  }

  private async watchFile(projectId: string, filePath: string, changed: () => void, failed: (error: Error) => void) {
    const project = await this.catalog.resolveProjectById(projectId);
    const file = resolveProjectFilePath(project, filePath);
    const name = path.basename(file.absolutePath);
    const watcher = watch(path.dirname(file.absolutePath), (_event, filename) => {
      if (!filename || filename.toString() === name) changed();
    });
    watcher.on("error", failed);
    let stopRefs: (() => void) | null = null;
    try {
      const repository = await WorkbenchGitRepository.tryOpen(file.gitRoot);
      if (repository) {
        const [gitDir, commonDir] = (await repository.run(["rev-parse", "--git-dir", "--git-common-dir"]))
          .trim().split(/\r?\n/u).map(directory => path.resolve(repository.root, directory));
        if (gitDir && commonDir) stopRefs = await watchGitRefs({ gitDir, commonDir }, ["heads"], changed, failed);
      }
    } catch (error) {
      failed(error instanceof Error ? error : new Error(failureMessage(error)));
    }
    return () => { watcher.close(); stopRefs?.(); };
  }

  async read({ path, projectId }: { path: string; projectId: string }) {
    const project = await this.catalog.resolveProjectById(projectId);
    const file = resolveProjectFilePath(project, path);
    const stats = await fs.stat(file.absolutePath);
    if (!isEditableFile(file.rootRelativePath)) throw new Error("Only markdown, SVG and .env files can be opened in the workbench.");
    if (!stats.isFile()) throw new Error("The requested path is not a file.");
    const [content, headContent] = await Promise.all([
      fs.readFile(file.absolutePath, "utf8"),
      getHeadFileContent(file.gitRoot, file.rootRelativePath),
    ]);
    return {
      content,
      headContent,
      mtimeMs: Math.trunc(stats.mtimeMs),
      path: file.displayPath,
      projectId: project.id,
      updatedAt: stats.mtime.toISOString(),
    };
  }

  async write(request: {
    content?: string;
    expectedMtimeMs: number;
    force?: boolean;
    path: string;
    projectId: string;
    resetToHead: boolean;
  }) {
    const project = await this.catalog.resolveProjectById(request.projectId);
    const file = resolveProjectFilePath(project, request.path);
    if (!isEditableFile(file.rootRelativePath)) throw new Error("Only markdown, SVG and .env files can be edited in the workbench.");
    // A forced save writes regardless of disk state, so it also creates a file, and its folders, that do not exist yet.
    const before = await fs.stat(file.absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && request.force && !request.resetToHead) return null;
      throw error;
    });
    if (before && !before.isFile()) throw new Error("The requested path is not a file.");
    const actualMtimeMs = before ? Math.trunc(before.mtimeMs) : 0;
    if (before && !request.force && actualMtimeMs !== Math.trunc(request.expectedMtimeMs)) {
      return {
        actualMtimeMs,
        actualUpdatedAt: before.mtime.toISOString(),
        error: "This file changed on disk after it was opened.",
        expectedMtimeMs: Math.trunc(request.expectedMtimeMs),
        expectedUpdatedAt: new Date(request.expectedMtimeMs).toISOString(),
        path: file.displayPath,
      } satisfies SaveConflictPayload;
    }
    const content = request.resetToHead
      ? await getHeadFileContent(file.gitRoot, file.rootRelativePath)
      : request.content;
    if (content === null) throw new Error("This file does not have a HEAD version to reset to.");
    if (typeof content !== "string") throw new Error("UTF-8 file content is required.");
    if (!before) await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
    await fs.writeFile(file.absolutePath, content, "utf8");
    const [snapshot, after] = await Promise.all([
      this.snapshots.refreshAfterFileMutation(project.id),
      fs.stat(file.absolutePath),
    ]);
    for (const [key, interest] of this.interests) {
      if (interest.projectId === request.projectId && interest.path === request.path) this.refresh(key, interest);
    }
    return {
      changes: snapshot.changes,
      mtimeMs: Math.trunc(after.mtimeMs),
      path: file.displayPath,
      projectId: project.id,
      updatedAt: after.mtime.toISOString(),
    };
  }
}
