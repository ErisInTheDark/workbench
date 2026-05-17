/*
 * Exports:
 * - appRoot: absolute path to the Next.js app workspace. Keywords: project, app root, workspace.
 * - projectRoot: absolute path to the repository root used by the workbench. Keywords: project, repo root, workspace.
 * - projectsRoot: absolute configured root scanned for selectable projects. Keywords: projects, discovery, root.
 * - normalizeRelativePath: normalize project paths to forward-slash form for client transport. Keywords: path, normalize, relative.
 * - safeResolve/safeResolveProjectPath: resolve and validate project-relative paths inside a selected project root. Keywords: path, resolve, safety.
 * - isPathWithinRoot: test whether an absolute path belongs to a project root. Keywords: path, root, thread filter.
 * - discoverProjects/resolveProjectRoot/getDefaultProjectId: find and resolve selectable git projects, newest HEAD activity first. Keywords: project, discovery, id, last commit.
 * - createProjectEntry: create a new project file or directory and return its normalized relative path. Keywords: create, file, directory.
 * - buildTree/buildProjectTree: build the visible explorer tree for a project. Keywords: tree, explorer, filesystem.
 * - getProjectSnapshot: assemble the project tree, root info, and git change summary for the client. Keywords: snapshot, project, explorer.
 * - listUserInvocableAgents/readUserInvocableAgentDefinition: discover user-invocable agent markdown files and load their metadata/prompt. Keywords: agent, prompt, custom agent, iterator.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getGitChanges } from "./git";
import type { ProjectSnapshot, TreeNode, WorkbenchAgentOption, WorkbenchProjectOption } from "./types";

export const appRoot = process.cwd();
export const projectRoot = path.resolve(appRoot, "..");
export const projectsRoot = path.resolve(process.env.WORKBENCH_PROJECTS_ROOT?.trim() || path.dirname(projectRoot));
const ignoredNames = new Set([".git", ".codex", ".vscode", ".workbench", "node_modules", ".next"]);
const discoveryIgnoredNames = new Set([...ignoredNames, "dist", "build", "coverage"]);
let discoveredProjectsCache: Promise<WorkbenchProjectOption[]> | null = null;

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

function normalizeProjectId(projectId: string) {
  return normalizeRelativePath(projectId).replace(/^\/+|\/+$/g, "");
}

function getAgentDirectoryPath(rootDir = projectRoot) {
  return path.join(rootDir, ".github", "agents");
}

function createAgentRelativePath(fileName: string) {
  return normalizeRelativePath(path.join(".github", "agents", fileName));
}

async function readAgentFile(rootDir: string, relativePath: string) {
  const absolutePath = safeResolveProjectPath(rootDir, relativePath);
  return await fs.readFile(absolutePath, "utf8");
}

export function normalizeRelativePath(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

export function safeResolveProjectPath(rootDir: string, requestPath: string) {
  const normalized = String(requestPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(rootDir, normalized);

  if (absolute !== rootDir && !absolute.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error("Path is outside the project workspace.");
  }

  return absolute;
}

export function safeResolve(requestPath: string) {
  return safeResolveProjectPath(projectRoot, requestPath);
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

async function hasGitMarker(rootDir: string) {
  try {
    const stats = await fs.lstat(path.join(rootDir, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

async function statMtimeMs(filePath: string) {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function resolveGitDirectory(rootDir: string) {
  const gitMarkerPath = path.join(rootDir, ".git");

  try {
    const stats = await fs.lstat(gitMarkerPath);
    if (stats.isDirectory()) {
      return gitMarkerPath;
    }
    if (!stats.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const marker = await readTextFile(gitMarkerPath);
  const gitDirMatch = /^gitdir:\s*(.+)\s*$/im.exec(marker ?? "");
  if (!gitDirMatch) {
    return null;
  }

  const gitDirPath = gitDirMatch[1].trim();
  return path.resolve(rootDir, gitDirPath);
}

function parseHeadRef(headContent: string | null) {
  const match = /^ref:\s*(.+)\s*$/m.exec(headContent ?? "");
  return match?.[1]?.trim() || null;
}

async function getPackedRefMtimeMs(gitDir: string, refName: string) {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  const packedRefs = await readTextFile(packedRefsPath);
  if (!packedRefs || !new RegExp(`^[0-9a-f]{40}\\s+${refName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "im").test(packedRefs)) {
    return null;
  }

  return await statMtimeMs(packedRefsPath);
}

async function getGitHeadActivityTimeMs(rootDir: string) {
  const gitDir = await resolveGitDirectory(rootDir);
  if (!gitDir) {
    return null;
  }

  const headPath = path.join(gitDir, "HEAD");
  const headContent = await readTextFile(headPath);
  const refName = parseHeadRef(headContent);
  const candidates = [await statMtimeMs(path.join(gitDir, "logs", "HEAD"))];

  if (refName) {
    candidates.push(await statMtimeMs(path.join(gitDir, ...refName.split("/"))));
    candidates.push(await getPackedRefMtimeMs(gitDir, refName));
  } else {
    candidates.push(await statMtimeMs(headPath));
  }

  return candidates.reduce<number | null>((latest, candidate) => {
    if (candidate === null) {
      return latest;
    }
    return latest === null ? candidate : Math.max(latest, candidate);
  }, null);
}

async function createProjectOption(rootDir: string): Promise<WorkbenchProjectOption> {
  const relativePath = normalizeRelativePath(path.relative(projectsRoot, rootDir)) || ".";
  const id = normalizeProjectId(relativePath) || ".";
  return {
    id,
    lastCommitTimeMs: await getGitHeadActivityTimeMs(rootDir),
    name: path.basename(rootDir) || id,
    relativePath: id,
    rootPath: normalizeRelativePath(rootDir),
  };
}

async function walkProjects(currentDir: string, projects: WorkbenchProjectOption[]) {
  if (await hasGitMarker(currentDir)) {
    projects.push(await createProjectOption(currentDir));
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !discoveryIgnoredNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

  for (const entry of directories) {
    await walkProjects(path.join(currentDir, entry.name), projects);
  }
}

export async function discoverProjects({ refresh = false }: { refresh?: boolean } = {}) {
  if (!discoveredProjectsCache || refresh) {
    discoveredProjectsCache = (async () => {
      const projects: WorkbenchProjectOption[] = [];
      await walkProjects(projectsRoot, projects);
      return projects.sort((left, right) => {
        const leftTime = left.lastCommitTimeMs ?? Number.NEGATIVE_INFINITY;
        const rightTime = right.lastCommitTimeMs ?? Number.NEGATIVE_INFINITY;
        if (leftTime !== rightTime) {
          return rightTime - leftTime;
        }

        return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
      });
    })();
  }

  return await discoveredProjectsCache;
}

export async function getDefaultProjectId() {
  const projects = await discoverProjects();
  const currentProjectOption = projects.find((project) => normalizePathForComparison(project.rootPath) === normalizePathForComparison(projectRoot));
  return currentProjectOption?.id ?? projects[0]?.id ?? "";
}

export async function resolveProjectRoot(projectId?: string | null) {
  const requestedProjectId = normalizeProjectId(projectId ?? "") || await getDefaultProjectId();
  if (!requestedProjectId) {
    throw new Error("No projects were found under the configured projects root.");
  }

  const projects = await discoverProjects();
  const project = projects.find((candidate) => candidate.id === requestedProjectId);
  if (!project) {
    throw new Error("Unknown project.");
  }

  const absolutePath = path.resolve(projectsRoot, project.relativePath === "." ? "" : project.relativePath);
  if (!isPathWithinRoot(absolutePath, projectsRoot)) {
    throw new Error("Project is outside the configured projects root.");
  }

  if (!await hasGitMarker(absolutePath)) {
    throw new Error("Project is missing a .git marker.");
  }

  return {
    id: project.id,
    root: absolutePath,
  };
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

export async function createProjectEntry(parentPath: string, name: string, type: "directory" | "file", rootDir = projectRoot) {
  const absoluteParentPath = safeResolveProjectPath(rootDir, parentPath);
  const parentStats = await fs.stat(absoluteParentPath);
  if (!parentStats.isDirectory()) {
    throw new Error("New entries can only be created inside folders.");
  }

  const normalizedName = normalizeEntryName(name, type);
  const absoluteEntryPath = path.join(absoluteParentPath, normalizedName);
  const relativeEntryPath = normalizeRelativePath(path.relative(rootDir, absoluteEntryPath));

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

export async function buildProjectTree(rootDir: string, currentDir = rootDir): Promise<TreeNode[]> {
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
    const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));

    if (entry.isDirectory()) {
      children.push({
        type: "directory",
        name: entry.name,
        path: relativePath,
        children: await buildProjectTree(rootDir, absolutePath),
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

export async function getProjectSnapshot(projectId?: string | null) {
  const resolvedProject = await resolveProjectRoot(projectId);
  const [tree, changes] = await Promise.all([buildProjectTree(resolvedProject.root), getGitChanges(resolvedProject.root)]);
  return {
    projectId: resolvedProject.id,
    root: path.basename(resolvedProject.root),
    rootPath: normalizeRelativePath(resolvedProject.root),
    tree,
    changes,
  } satisfies ProjectSnapshot;
}

export async function listUserInvocableAgents(projectId?: string | null) {
  const resolvedProject = await resolveProjectRoot(projectId);
  try {
    const entries = await fs.readdir(getAgentDirectoryPath(resolvedProject.root), { withFileTypes: true });
    const agents: WorkbenchAgentOption[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
        continue;
      }

      const relativePath = createAgentRelativePath(entry.name);
      const content = await readAgentFile(resolvedProject.root, relativePath);
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

export async function readUserInvocableAgentDefinition(relativePath: string, projectId?: string | null) {
  const resolvedProject = await resolveProjectRoot(projectId);
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath.startsWith(".github/agents/") || !normalizedPath.endsWith(".agent.md")) {
    throw new Error("Agent path is outside the supported agents directory.");
  }

  const content = await readAgentFile(resolvedProject.root, normalizedPath);
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
