/*
 * Exports:
 * - appRoot: absolute path to the Next.js app workspace. Keywords: project, app root, workspace.
 * - projectRoot: absolute path to the repository root used by the workbench. Keywords: project, repo root, workspace.
 * - normalizeRelativePath: normalize project paths to forward-slash form for client transport. Keywords: path, normalize, relative.
 * - safeResolve: resolve and validate project-relative paths inside the repo root. Keywords: path, resolve, safety.
 * - isPathWithinRoot: test whether an absolute path belongs to the current project root. Keywords: path, root, thread filter.
 * - createProjectEntry: create a new project file or directory and return its normalized relative path. Keywords: create, file, directory.
 * - buildTree: build the visible explorer tree for the project. Keywords: tree, explorer, filesystem.
 * - getProjectSnapshot: assemble the project tree, root info, and git change summary for the client. Keywords: snapshot, project, explorer.
 * - listUserInvocableAgents/readUserInvocableAgentDefinition: discover user-invocable agent markdown files and load their metadata/prompt. Keywords: agent, prompt, custom agent, iterator.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getGitChanges } from "./git";
import type { ProjectSnapshot, TreeNode, WorkbenchAgentOption } from "./types";

export const appRoot = process.cwd();
export const projectRoot = path.resolve(appRoot, "..");
const ignoredNames = new Set([".git", ".codex", ".vscode", ".workbench", ".gitignore", "node_modules", ".next", "webapp"]);

function parseFrontmatterBlock(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    return null;
  }

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, "");
    fields.set(key, value);
  }

  return fields;
}

function getAgentDirectoryPath() {
  return path.join(projectRoot, ".github", "agents");
}

function createAgentRelativePath(fileName: string) {
  return normalizeRelativePath(path.join(".github", "agents", fileName));
}

async function readAgentFile(relativePath: string) {
  const absolutePath = safeResolve(relativePath);
  return await fs.readFile(absolutePath, "utf8");
}

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

function normalizePathForComparison(filePath: string) {
  const normalized = path.resolve(String(filePath ?? "")).split(path.sep).join("/").replace(/\/+$/, "");
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

export function isPathWithinRoot(candidatePath: string, rootPath = projectRoot) {
  if (!String(candidatePath ?? "").trim() || !String(rootPath ?? "").trim()) {
    return false;
  }

  const normalizedCandidatePath = normalizePathForComparison(candidatePath);
  const normalizedRootPath = normalizePathForComparison(rootPath);
  return normalizedCandidatePath === normalizedRootPath
    || normalizedCandidatePath.startsWith(`${normalizedRootPath}/`);
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
    rootPath: normalizeRelativePath(projectRoot),
    tree,
    changes,
  } satisfies ProjectSnapshot;
}

export async function listUserInvocableAgents() {
  try {
    const entries = await fs.readdir(getAgentDirectoryPath(), { withFileTypes: true });
    const agents: WorkbenchAgentOption[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
        continue;
      }

      const relativePath = createAgentRelativePath(entry.name);
      const content = await readAgentFile(relativePath);
      const frontmatter = parseFrontmatterBlock(content);
      if (!frontmatter || frontmatter.get("user-invocable") !== "true") {
        continue;
      }

      agents.push({
        name: frontmatter.get("name") ?? entry.name.replace(/\.agent\.md$/i, ""),
        description: frontmatter.get("description") ?? "",
        path: relativePath,
      });
    }

    return agents.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readUserInvocableAgentDefinition(relativePath: string) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath.startsWith(".github/agents/") || !normalizedPath.endsWith(".agent.md")) {
    throw new Error("Agent path is outside the supported agents directory.");
  }

  const content = await readAgentFile(normalizedPath);
  const frontmatter = parseFrontmatterBlock(content);
  if (!frontmatter || frontmatter.get("user-invocable") !== "true") {
    throw new Error("Agent is not user-invocable.");
  }

  const prompt = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return {
    description: frontmatter.get("description") ?? "",
    name: frontmatter.get("name") ?? path.basename(normalizedPath, ".agent.md"),
    path: normalizedPath,
    prompt,
  };
}
