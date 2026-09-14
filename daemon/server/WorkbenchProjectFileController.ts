/*
 * Exports:
 * - default WorkbenchProjectFileController: own validated project file reads, writes, HEAD resets, and mtime conflicts.
 */
import fs from "node:fs/promises";

import { getHeadFileContent } from "./lib/git";
import { resolveProjectFilePath } from "./lib/project";
import type { ChangeSummary, SaveConflictPayload } from "workbench-shared/types";
import { isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";

export default class WorkbenchProjectFileController {
  constructor(
    private readonly catalog: Pick<WorkbenchProjectCatalogController, "resolveProjectById">,
    private readonly snapshots: {
      refreshAfterFileMutation(projectId: string): Promise<{ changes: Record<string, ChangeSummary> }>;
    },
  ) {}

  async read({ path, projectId }: { path: string; projectId: string }) {
    const project = await this.catalog.resolveProjectById(projectId);
    const file = resolveProjectFilePath(project, path);
    const stats = await fs.stat(file.absolutePath);
    if (!isWorkbenchOpenableFile(file.rootRelativePath)) throw new Error("Only markdown files can be opened in the workbench.");
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
    const before = await fs.stat(file.absolutePath);
    if (!isWorkbenchOpenableFile(file.rootRelativePath)) throw new Error("Only markdown files can be edited in the workbench.");
    if (!before.isFile()) throw new Error("The requested path is not a file.");
    const actualMtimeMs = Math.trunc(before.mtimeMs);
    if (!request.force && actualMtimeMs !== Math.trunc(request.expectedMtimeMs)) {
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
    await fs.writeFile(file.absolutePath, content, "utf8");
    const [snapshot, after] = await Promise.all([
      this.snapshots.refreshAfterFileMutation(project.id),
      fs.stat(file.absolutePath),
    ]);
    return {
      changes: snapshot.changes,
      mtimeMs: Math.trunc(after.mtimeMs),
      path: file.displayPath,
      projectId: project.id,
      updatedAt: after.mtime.toISOString(),
    };
  }
}
