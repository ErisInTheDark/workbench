import fs from "node:fs/promises";
import path from "node:path";

import { getGitChanges } from "./git";
import type { ProjectSnapshot, TreeNode } from "./types";

export const appRoot = process.cwd();
export const projectRoot = path.resolve(appRoot, "..");
const ignoredNames = new Set([".git", ".codex", ".vscode", ".gitignore", "node_modules", ".next", "webapp"]);

export function normalizeRelativePath(filePath: string) {
  return filePath.split(path.sep).join("/");
}

export function safeResolve(requestPath: string) {
  const normalized = String(requestPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(projectRoot, normalized);

  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Path is outside the project workspace.");
  }

  return absolute;
}

function normalizeEntryName(name: string, type: "directory" | "file") {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    throw new Error(`A ${type === "file" ? "file" : "folder"} name is required.`);
  }

  if (trimmedName === "." || trimmedName === ".." || /[\\/]/.test(trimmedName)) {
    throw new Error("Names cannot contain path separators.");
  }

  if (type === "directory") {
    return trimmedName;
  }

  const withoutExtension = trimmedName.replace(/\.md$/i, "").trim();
  if (!withoutExtension) {
    throw new Error("A file name is required.");
  }

  return `${withoutExtension}.md`;
}

export async function createProjectEntry(parentPath: string, name: string, type: "directory" | "file") {
  const absoluteParentPath = safeResolve(parentPath);
  const parentStats = await fs.stat(absoluteParentPath);
  if (!parentStats.isDirectory()) {
    throw new Error("New entries can only be created inside folders.");
  }

  const normalizedName = normalizeEntryName(name, type);
  const absoluteEntryPath = path.join(absoluteParentPath, normalizedName);
  const relativeEntryPath = normalizeRelativePath(path.relative(projectRoot, absoluteEntryPath));

  try {
    await fs.access(absoluteEntryPath);
    throw new Error(`A ${type === "file" ? "file" : "folder"} with that name already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  if (type === "directory") {
    await fs.mkdir(absoluteEntryPath);
  } else {
    await fs.writeFile(absoluteEntryPath, "", "utf8");
  }

  return relativeEntryPath;
}

export async function buildTree(currentDir = projectRoot): Promise<TreeNode[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !ignoredNames.has(entry.name))
    .sort((left, right) => {
      const leftRank = left.isDirectory() ? 0 : 1;
      const rightRank = right.isDirectory() ? 0 : 1;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

  const children: TreeNode[] = [];

  for (const entry of visibleEntries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, absolutePath));

    if (entry.isDirectory()) {
      children.push({
        type: "directory",
        name: entry.name,
        path: relativePath,
        children: await buildTree(absolutePath),
      });
      continue;
    }

    children.push({
      type: "file",
      name: entry.name,
      path: relativePath,
    });
  }

  return children;
}

export async function getProjectSnapshot() {
  const [tree, changes] = await Promise.all([buildTree(), getGitChanges(projectRoot)]);
  return {
    root: path.basename(projectRoot),
    tree,
    changes,
  } satisfies ProjectSnapshot;
}
