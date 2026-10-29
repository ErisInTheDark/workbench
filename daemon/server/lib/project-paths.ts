/*
 * Exports:
 * - normalizeRelativePath: normalise transport paths to forward slashes.
 * - safeResolveProjectPath: resolve a project-relative path, rejecting escapes from the root.
 * - isPathWithinRoot: check absolute path containment, defaulting to the Workbench repository root.
 */
import path from "node:path";
import { isPathInside } from "./comparable-path";
import { projectRoot } from "./project-root";

export function normalizeRelativePath(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

export function safeResolveProjectPath(rootDir: string, requestPath: string) {
  const normalized = String(requestPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const absoluteRoot = path.resolve(rootDir);
  const absolute = path.resolve(absoluteRoot, normalized);
  if (!isPathInside(absolute, absoluteRoot)) {
    throw new Error("Path is outside the project workspace.");
  }

  return absolute;
}

export function isPathWithinRoot(candidatePath: string, rootPath = projectRoot) {
  if (!String(candidatePath ?? "").trim() || !String(rootPath ?? "").trim()) {
    return false;
  }
  return isPathInside(candidatePath, rootPath);
}
