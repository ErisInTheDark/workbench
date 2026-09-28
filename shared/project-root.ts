/*
 * Exports:
 * - appRoot: absolute Workbench server workspace. Keywords: project, root, workspace, cwd.
 * - projectRoot: absolute Workbench repository root, one level above the server workspace. Keywords: project, root, repository.
 */
import path from "node:path";

export const appRoot = process.cwd();
export const projectRoot = path.resolve(appRoot, "..");
