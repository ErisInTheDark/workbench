/*
 * Exports:
 * - WORKBENCH_TEMPORARY_ROOT_ENV: child-process override for a validated directory inside this Workbench project's temp root. Keywords: temp, environment, tests.
 * - default WorkbenchTemporaryDirectory: resolve, create, and dispose Workbench-owned temporary directories under this project's `.workbench/tmp`. Keywords: temp, lifecycle, cleanup, project.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { projectRoot } from "../project";

export const WORKBENCH_TEMPORARY_ROOT_ENV = "WORKBENCH_TEMPORARY_ROOT";

function isWithinRoot(candidatePath: string, rootPath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export default class WorkbenchTemporaryDirectory {
  static readonly projectRootPath = path.join(projectRoot, ".workbench", "tmp");

  static get rootPath() {
    const configured = process.env[WORKBENCH_TEMPORARY_ROOT_ENV]?.trim();
    if (!configured) return this.projectRootPath;
    const resolved = path.resolve(configured);
    if (!isWithinRoot(resolved, this.projectRootPath)) {
      throw new Error(`${WORKBENCH_TEMPORARY_ROOT_ENV} must stay inside ${this.projectRootPath}.`);
    }
    return resolved;
  }

  static resolve(...segments: string[]) {
    const rootPath = this.rootPath;
    const resolved = path.resolve(rootPath, ...segments);
    if (!isWithinRoot(resolved, rootPath)) throw new Error("Workbench temporary paths must stay inside the active temp root.");
    return resolved;
  }

  static async create(prefix: string, rootPath = this.rootPath) {
    const resolvedRoot = path.resolve(rootPath);
    if (!isWithinRoot(resolvedRoot, this.projectRootPath)) {
      throw new Error("Workbench temporary directories must stay inside this project's temp root.");
    }
    if (!prefix || path.basename(prefix) !== prefix) throw new Error("Workbench temporary directory prefixes must be one path segment.");
    await fs.mkdir(resolvedRoot, { recursive: true });
    return new WorkbenchTemporaryDirectory(await fs.mkdtemp(path.join(resolvedRoot, prefix)));
  }

  private constructor(readonly path: string) {}

  async dispose() {
    await fs.rm(this.path, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
}
