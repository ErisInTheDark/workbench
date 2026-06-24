/*
 * Exports:
 * - WORKBENCH_LIBRARY_PROJECT_ID: stable project id for the external Workbench Library. Keywords: workbench library, project id.
 * - workbenchLibraryRoot: absolute root for personal Workbench skills, agents, workflows, and instructions. Keywords: workbench library, root.
 * - normalizeWorkbenchLibraryPath: normalize library paths to forward-slash form. Keywords: path, normalize, library.
 * - safeResolveWorkbenchLibraryPath: resolve and validate paths inside the Workbench Library. Keywords: path, resolve, safety.
 */
import os from "node:os";
import path from "node:path";

export const WORKBENCH_LIBRARY_PROJECT_ID = "workbench-library";
export const workbenchLibraryRoot = path.resolve(process.env.WORKBENCH_LIBRARY_ROOT?.trim() || path.join(os.homedir(), ".workbench"));

export function normalizeWorkbenchLibraryPath(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

export function safeResolveWorkbenchLibraryPath(relativePath: string) {
  const normalized = normalizeWorkbenchLibraryPath(relativePath).replace(/^\/+/, "");
  const absolutePath = path.resolve(workbenchLibraryRoot, normalized);

  if (absolutePath !== workbenchLibraryRoot && !absolutePath.startsWith(`${workbenchLibraryRoot}${path.sep}`)) {
    throw new Error("Path is outside the Workbench Library.");
  }

  return absolutePath;
}
