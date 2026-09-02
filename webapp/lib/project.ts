/*
 * Exports:
 * - appRoot: absolute path to the Workbench server workspace. Keywords: project, app root, workspace.
 * - projectRoot: absolute path to the repository root used by the workbench. Keywords: project, repo root, workspace.
 * - projectsRoot: absolute configured root scanned for selectable projects. Keywords: projects, discovery, root.
 * - normalizeRelativePath: normalize project paths to forward-slash form for client transport. Keywords: path, normalize, relative.
 * - safeResolve/safeResolveProjectPath: resolve and validate project-relative paths inside a selected project root. Keywords: path, resolve, safety.
 * - isPathWithinRoot: test whether an absolute path belongs to a project root. Keywords: path, root, thread filter.
 * - discoverProjects/resolveDiscoveredProject/resolveProjectRootFromProjects/resolveProjectRoot/getDefaultProjectId: find selectable git projects and VS Code workspaces with preferred icons, newest HEAD activity first, then resolve their roots. Keywords: project, workspace, discovery, catalog, icon, id, last commit.
 * - createProjectEntry/assertProjectFileCanBeDeleted/deleteProjectFile: create project entries, validate deletion targets, or permanently delete one project file. Keywords: create, delete, file, directory.
 * - buildTree/buildProjectTree: build the visible explorer tree for a project. Keywords: tree, explorer, filesystem.
 * - getProjectSnapshot/getProjectSnapshotFromResolvedProject: assemble the project tree, root info, and git change summary for the client. Keywords: snapshot, project, explorer.
 * - resolveExternalFileLinkRoot: find the owning git root for an absolute local file link. Keywords: file link, absolute path, git root.
 * - parseWorkspaceQualifiedPath/formatWorkspaceQualifiedPath/resolveProjectFilePath: resolve root-qualified workspace paths. Keywords: workspace root, file path, qualified path.
 * - listProjectSkills/listProjectSkillDefinitions/listProjectSkillDefinitionsFromRoot: discover project-level Workbench Skill metadata and full file content from `.agents/skills`. Keywords: project, skills, manifest.
 * - listUserInvocableAgents/listUserInvocableAgentsFromResolvedProject/readUserInvocableAgentDefinition/readUserInvocableAgentDefinitionFromRoot: discover project-level agent markdown files from `.agents/agents` and load metadata/prompt. Keywords: agent, prompt, custom agent, iterator.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getGitChanges } from "./git";
import type { ProjectSnapshot, TreeNode, WorkbenchAgentDefinition, WorkbenchAgentOption, WorkbenchProjectOption, WorkbenchProjectRoot, WorkbenchSkillDefinition, WorkbenchSkillSummary } from "./types";
import { discoverWorkbenchProjectIcon } from "./workbench/project/project-icon-discovery";
import { createGitignoreMatcher } from "./workbench/gitignore-matcher";
import {
  ensureWorkbenchLibrary,
  listWorkbenchLibraryAgents,
  parseFrontmatterBlock,
  readWorkbenchLibraryAgentDefinition,
  WORKBENCH_LIBRARY_PROJECT_ID,
  workbenchLibraryRoot,
} from "./workbench-library";

export const appRoot = process.cwd();
export const projectRoot = path.resolve(appRoot, "..");
export const projectsRoot = path.resolve(process.env.WORKBENCH_PROJECTS_ROOT?.trim() || path.dirname(projectRoot));
const ignoredNames = new Set([".git", ".codex", ".vscode", ".workbench", "node_modules", ".next"]);
const discoveryIgnoredNames = new Set([...ignoredNames, "dist", "build", "coverage"]);
const README_FILE_NAME = "README.md";
const WORKSPACE_FILE_EXTENSION = ".code-workspace";

function normalizeProjectId(projectId: string) {
  return normalizeRelativePath(projectId).replace(/^\/+|\/+$/g, "");
}

function normalizeWorkspaceRootId(value: string) {
  return normalizeRelativePath(value)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.trim()
    .replace(/:/g, "-")
    .replace(/\s+/g, "-")
    || "root";
}

function createUniqueWorkspaceRootId(rawId: string, usedIds: Set<string>) {
  const baseId = normalizeWorkspaceRootId(rawId);
  let candidateId = baseId;
  let suffix = 2;
  while (usedIds.has(candidateId)) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidateId);
  return candidateId;
}

function getAgentDirectoryPath(rootDir = projectRoot) {
  return path.join(rootDir, ".agents", "agents");
}

function getProjectSkillDirectoryPath(rootDir = projectRoot) {
  return path.join(rootDir, ".agents", "skills");
}

function createAgentRelativePath(fileName: string) {
  return normalizeRelativePath(path.join(".agents", "agents", fileName));
}

function createProjectSkillRelativePath(directoryName: string) {
  return normalizeRelativePath(path.join(".agents", "skills", directoryName, "SKILL.md"));
}

function isAgentMarkdownFile(fileName: string) {
  return fileName.endsWith(".md")
    && path.basename(fileName) !== README_FILE_NAME
    && !fileName.endsWith(".template.md");
}

function isAgentUserInvocable(frontmatter: Map<string, string> | null) {
  return frontmatter?.get("user-invocable") !== "false";
}

function getAgentNameFromFileName(fileName: string) {
  return fileName.replace(/\.md$/i, "");
}

async function readAgentFile(rootDir: string, relativePath: string) {
  const absolutePath = safeResolveProjectPath(rootDir, relativePath);
  return await fs.readFile(absolutePath, "utf8");
}

export function normalizeRelativePath(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

async function createProjectGitignoreMatcher(rootDir: string) {
  let contents = "";
  try {
    contents = await fs.readFile(path.join(rootDir, ".gitignore"), "utf8");
  } catch {
    return () => false;
  }

  return createGitignoreMatcher(contents).matches;
}

export function safeResolveProjectPath(rootDir: string, requestPath: string) {
  const normalized = String(requestPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const absoluteRoot = path.resolve(rootDir);
  const absolute = path.resolve(absoluteRoot, normalized);
  const comparableRoot = normalizePathForComparison(absoluteRoot);
  const comparableAbsolute = normalizePathForComparison(absolute);

  if (comparableAbsolute !== comparableRoot && !comparableAbsolute.startsWith(`${comparableRoot}/`)) {
    throw new Error("Path is outside the project workspace.");
  }

  return absolute;
}

export function safeResolve(requestPath: string) {
  return safeResolveProjectPath(projectRoot, requestPath);
}

export function formatWorkspaceQualifiedPath(rootId: string, relativePath: string) {
  const normalizedRootId = normalizeWorkspaceRootId(rootId);
  const normalizedPath = normalizeRelativePath(relativePath).replace(/^\/+/, "");
  return normalizedPath ? `${normalizedRootId}:${normalizedPath}` : `${normalizedRootId}:`;
}

export function parseWorkspaceQualifiedPath(requestPath: string) {
  const normalizedPath = normalizeRelativePath(requestPath).replace(/^\/+/, "");
  const separatorIndex = normalizedPath.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    rootId: normalizedPath.slice(0, separatorIndex),
    relativePath: normalizedPath.slice(separatorIndex + 1).replace(/^\/+/, ""),
  };
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

function isLocalAbsolutePath(filePath: string) {
  const normalizedPath = normalizeRelativePath(String(filePath ?? "").trim());
  return path.isAbsolute(filePath) && !normalizedPath.startsWith("//");
}

async function findNearestGitRoot(startDir: string) {
  let currentDir = path.resolve(startDir);
  for (;;) {
    if (await hasGitMarker(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export async function resolveExternalFileLinkRoot(filePath: string) {
  const candidatePath = String(filePath ?? "").trim();
  if (!isLocalAbsolutePath(candidatePath)) {
    return null;
  }

  const absolutePath = path.resolve(candidatePath);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    return null;
  }

  if (!stats.isFile()) {
    return null;
  }

  const gitRoot = await findNearestGitRoot(path.dirname(absolutePath));
  return gitRoot
    ? {
      id: normalizeWorkspaceRootId(path.basename(gitRoot) || "root"),
      rootPath: normalizeRelativePath(gitRoot),
    }
    : null;
}

async function isDirectory(rootDir: string) {
  try {
    return (await fs.stat(rootDir)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveCanonicalPath(filePath: string) {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
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

export interface ResolvedProjectRoot {
  id: string;
  name: string;
  relativePath?: string;
  root: string;
  rootPath: string;
}

export interface ResolvedProject {
  id: string;
  kind: WorkbenchProjectOption["kind"];
  root: string;
  rootPath: string;
  roots: ResolvedProjectRoot[];
}

function createSingleProjectRoot(discoveryRootDir: string, canonicalRootDir: string): WorkbenchProjectRoot {
  const name = path.basename(discoveryRootDir) || ".";
  return {
    id: normalizeWorkspaceRootId(name),
    isPrimary: true,
    name,
    relativePath: normalizeRelativePath(path.relative(projectsRoot, discoveryRootDir)) || ".",
    rootPath: normalizeRelativePath(canonicalRootDir),
  };
}

async function createProjectOption(rootDir: string): Promise<WorkbenchProjectOption> {
  const relativePath = normalizeRelativePath(path.relative(projectsRoot, rootDir)) || ".";
  const id = normalizeProjectId(relativePath) || ".";
  const canonicalRootDir = await resolveCanonicalPath(rootDir);
  const root = createSingleProjectRoot(rootDir, canonicalRootDir);
  const icon = await discoverWorkbenchProjectIcon([root]);
  return {
    id,
    ...(icon ? { icon } : {}),
    kind: "git",
    lastCommitTimeMs: await getGitHeadActivityTimeMs(canonicalRootDir),
    name: path.basename(rootDir) || id,
    relativePath: id,
    rootPath: normalizeRelativePath(canonicalRootDir),
    roots: [root],
  };
}

async function createWorkbenchLibraryProjectOption(): Promise<WorkbenchProjectOption> {
  await ensureWorkbenchLibrary();
  const root = {
    id: "workbench-library",
    isPrimary: true,
    name: "Workbench Library",
    relativePath: WORKBENCH_LIBRARY_PROJECT_ID,
    rootPath: normalizeRelativePath(workbenchLibraryRoot),
  };
  return {
    id: WORKBENCH_LIBRARY_PROJECT_ID,
    kind: "workbench-library",
    lastCommitTimeMs: null,
    name: "Workbench Library",
    relativePath: WORKBENCH_LIBRARY_PROJECT_ID,
    rootPath: normalizeRelativePath(workbenchLibraryRoot),
    roots: [root],
  };
}

function stripJsonComments(content: string) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      result += character;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      while (index < content.length && !/[\r\n]/u.test(content[index])) {
        index += 1;
      }
      result += content[index] ?? "";
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += character;
  }

  return result;
}

function stripJsonTrailingCommas(content: string) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      result += character;
      continue;
    }

    if (character === ",") {
      let lookaheadIndex = index + 1;
      while (/\s/u.test(content[lookaheadIndex] ?? "")) {
        lookaheadIndex += 1;
      }
      if (content[lookaheadIndex] === "}" || content[lookaheadIndex] === "]") {
        continue;
      }
    }

    result += character;
  }

  return result;
}

function parseJsonc(content: string) {
  return JSON.parse(stripJsonTrailingCommas(stripJsonComments(content)));
}

function getWorkspaceFolderName(folder: Record<string, unknown>, resolvedRoot: string) {
  const configuredName = typeof folder.name === "string" ? folder.name.trim() : "";
  return configuredName || path.basename(resolvedRoot) || "root";
}

async function createWorkspaceProjectOption(workspacePath: string): Promise<WorkbenchProjectOption | null> {
  const content = await readTextFile(workspacePath);
  if (!content) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { folders?: unknown }).folders)) {
    return null;
  }

  const workspaceDirectory = path.dirname(workspacePath);
  const usedRootIds = new Set<string>();
  const roots: WorkbenchProjectRoot[] = [];
  let latestCommitTimeMs: number | null = null;

  for (const rawFolder of (parsed as { folders: unknown[] }).folders) {
    if (!rawFolder || typeof rawFolder !== "object") {
      continue;
    }

    const folder = rawFolder as Record<string, unknown>;
    if (typeof folder.path !== "string" || !folder.path.trim()) {
      continue;
    }

    const discoveryRoot = path.resolve(workspaceDirectory, folder.path);
    if (!await isDirectory(discoveryRoot)) {
      continue;
    }

    const canonicalRoot = await resolveCanonicalPath(discoveryRoot);
    const name = getWorkspaceFolderName(folder, discoveryRoot);
    const id = createUniqueWorkspaceRootId(name, usedRootIds);
    const commitTimeMs = await getGitHeadActivityTimeMs(canonicalRoot);
    latestCommitTimeMs = commitTimeMs === null
      ? latestCommitTimeMs
      : latestCommitTimeMs === null
        ? commitTimeMs
        : Math.max(latestCommitTimeMs, commitTimeMs);

    roots.push({
      id,
      isPrimary: roots.length === 0,
      name,
      relativePath: normalizeRelativePath(path.relative(projectsRoot, discoveryRoot)) || ".",
      rootPath: normalizeRelativePath(canonicalRoot),
    });
  }

  if (!roots.length) {
    return null;
  }

  const relativePath = normalizeRelativePath(path.relative(projectsRoot, workspacePath)) || path.basename(workspacePath);
  const id = normalizeProjectId(relativePath);
  const name = path.basename(workspacePath, WORKSPACE_FILE_EXTENSION);
  const icon = await discoverWorkbenchProjectIcon(roots);

  return {
    id,
    ...(icon ? { icon } : {}),
    kind: "workspace",
    lastCommitTimeMs: latestCommitTimeMs,
    name,
    relativePath: id,
    rootPath: roots[0].rootPath,
    roots,
    workspacePath: normalizeRelativePath(workspacePath),
  };
}

async function walkProjects(currentDir: string, projects: WorkbenchProjectOption[]) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  const workspaceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(WORKSPACE_FILE_EXTENSION))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

  for (const entry of workspaceFiles) {
    const workspaceProject = await createWorkspaceProjectOption(path.join(currentDir, entry.name));
    if (workspaceProject) {
      projects.push(workspaceProject);
    }
  }

  if (await hasGitMarker(currentDir)) {
    projects.push(await createProjectOption(currentDir));
    return;
  }

  const directories: typeof entries = [];
  for (const entry of entries) {
    if (discoveryIgnoredNames.has(entry.name)) {
      continue;
    }

    const isLinkedGitProject = entry.isSymbolicLink()
      && await hasGitMarker(path.join(currentDir, entry.name));
    if (entry.isDirectory() || isLinkedGitProject) {
      directories.push(entry);
    }
  }
  directories.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

  for (const entry of directories) {
    await walkProjects(path.join(currentDir, entry.name), projects);
  }
}

function filterIndirectGitProjectDuplicates(
  projects: readonly WorkbenchProjectOption[],
  canonicalProjectsRoot: string,
) {
  const directGitRootPaths = new Set<string>();
  for (const project of projects) {
    if (project.kind !== "git") {
      continue;
    }

    const discoveryPath = path.resolve(canonicalProjectsRoot, project.relativePath);
    const canonicalRootPath = normalizePathForComparison(project.rootPath);
    if (normalizePathForComparison(discoveryPath) === canonicalRootPath) {
      directGitRootPaths.add(canonicalRootPath);
    }
  }

  return projects.filter((project) => {
    if (project.kind !== "git") {
      return true;
    }

    const canonicalRootPath = normalizePathForComparison(project.rootPath);
    const discoveryPath = path.resolve(canonicalProjectsRoot, project.relativePath);
    return normalizePathForComparison(discoveryPath) === canonicalRootPath
      || !directGitRootPaths.has(canonicalRootPath);
  });
}

export async function discoverProjects() {
  const projects: WorkbenchProjectOption[] = [];
  const libraryProject = await createWorkbenchLibraryProjectOption();
  await walkProjects(projectsRoot, projects);
  const canonicalProjectsRoot = await resolveCanonicalPath(projectsRoot);
  const normalizedLibraryRoot = normalizePathForComparison(workbenchLibraryRoot);
  const discoveredProjects = filterIndirectGitProjectDuplicates(projects, canonicalProjectsRoot)
    .filter((project) => normalizePathForComparison(project.rootPath) !== normalizedLibraryRoot)
    .sort((left, right) => {
      const leftTime = left.lastCommitTimeMs ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.lastCommitTimeMs ?? Number.NEGATIVE_INFINITY;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
    });
  return [libraryProject, ...discoveredProjects];
}

function getDefaultProjectIdFromProjects(projects: readonly WorkbenchProjectOption[]) {
  const currentProjectId = normalizeProjectId(path.relative(projectsRoot, projectRoot)) || ".";
  const currentProjectOption = projects.find((project) => project.kind === "git" && (
    project.id === currentProjectId
    || normalizePathForComparison(project.rootPath) === normalizePathForComparison(projectRoot)
  ));
  return currentProjectOption?.id ?? projects[0]?.id ?? "";
}

export async function getDefaultProjectId() {
  return getDefaultProjectIdFromProjects(await discoverProjects());
}

export async function resolveProjectRoot(projectId?: string | null): Promise<ResolvedProject> {
  return await resolveProjectRootFromProjects(await discoverProjects(), projectId);
}

export async function resolveProjectRootFromProjects(
  projects: readonly WorkbenchProjectOption[],
  projectId?: string | null,
): Promise<ResolvedProject> {
  const requestedProjectId = normalizeProjectId(projectId ?? "") || getDefaultProjectIdFromProjects(projects);
  if (!requestedProjectId) {
    throw new Error("No projects were found under the configured projects root.");
  }

  const project = projects.find((candidate) => candidate.id === requestedProjectId);
  if (!project) {
    throw new Error("Unknown project.");
  }

  return await resolveDiscoveredProject(project);
}

export async function resolveDiscoveredProject(project: WorkbenchProjectOption): Promise<ResolvedProject> {
  if (project.kind === "workbench-library") {
    await ensureWorkbenchLibrary();
    return {
      id: project.id,
      kind: project.kind,
      root: workbenchLibraryRoot,
      rootPath: normalizeRelativePath(workbenchLibraryRoot),
      roots: [{
        id: project.roots[0]?.id ?? "workbench-library",
        name: project.roots[0]?.name ?? "Workbench Library",
        relativePath: project.roots[0]?.relativePath ?? WORKBENCH_LIBRARY_PROJECT_ID,
        root: workbenchLibraryRoot,
        rootPath: normalizeRelativePath(workbenchLibraryRoot),
      }],
    } satisfies ResolvedProject;
  }

  if (project.kind === "workspace") {
    const roots = project.roots.map((root) => ({
      id: root.id,
      name: root.name,
      relativePath: root.relativePath,
      root: path.resolve(root.rootPath),
      rootPath: normalizeRelativePath(path.resolve(root.rootPath)),
    }));
    if (!roots.length) {
      throw new Error("Workspace is missing roots.");
    }

    for (const root of roots) {
      if (!await isDirectory(root.root)) {
        throw new Error(`Workspace root is missing a directory: ${root.name}`);
      }
    }

    return {
      id: project.id,
      kind: project.kind,
      root: roots[0].root,
      rootPath: roots[0].rootPath,
      roots,
    } satisfies ResolvedProject;
  }

  const discoveryPath = path.resolve(projectsRoot, project.relativePath);
  if (!isPathWithinRoot(discoveryPath, projectsRoot)) {
    throw new Error("Project is outside the configured projects root.");
  }

  const canonicalRoot = await resolveCanonicalPath(discoveryPath);
  if (project.kind !== "git" || !await hasGitMarker(canonicalRoot)) {
    throw new Error("Project is missing a .git marker.");
  }

  return {
    id: project.id,
    kind: project.kind,
    root: canonicalRoot,
    rootPath: normalizeRelativePath(canonicalRoot),
    roots: [{
      id: project.roots[0]?.id ?? normalizeWorkspaceRootId(path.basename(discoveryPath) || project.id),
      name: project.roots[0]?.name ?? (path.basename(discoveryPath) || project.id),
      relativePath: project.roots[0]?.relativePath ?? project.relativePath,
      root: canonicalRoot,
      rootPath: normalizeRelativePath(canonicalRoot),
    }],
  } satisfies ResolvedProject;
}

function toProjectSnapshotRoots(project: ResolvedProject): WorkbenchProjectRoot[] {
  return project.roots.map((root, index) => ({
    id: root.id,
    isPrimary: index === 0,
    name: root.name,
    relativePath: root.relativePath ?? (normalizeRelativePath(path.relative(projectsRoot, root.root)) || "."),
    rootPath: root.rootPath,
  }));
}

function findWorkspaceRoot(project: ResolvedProject, rootId: string) {
  return project.roots.find((root) => root.id === rootId || root.name === rootId) ?? null;
}

export function resolveProjectFilePath(project: ResolvedProject, requestPath: string) {
  if (project.kind !== "workspace") {
    const normalizedPath = normalizeRelativePath(requestPath).replace(/^\/+/, "");
    return {
      absolutePath: safeResolveProjectPath(project.root, normalizedPath),
      displayPath: normalizedPath,
      gitRoot: project.root,
      root: project.roots[0],
      rootRelativePath: normalizedPath,
    };
  }

  const qualifiedPath = parseWorkspaceQualifiedPath(requestPath);
  if (!qualifiedPath && !String(requestPath ?? "").trim()) {
    const root = project.roots[0];
    return {
      absolutePath: root.root,
      displayPath: formatWorkspaceQualifiedPath(root.id, ""),
      gitRoot: root.root,
      root,
      rootRelativePath: "",
    };
  }

  if (!qualifiedPath) {
    throw new Error("Workspace file paths must use the root:path format.");
  }

  const root = findWorkspaceRoot(project, qualifiedPath.rootId);
  if (!root) {
    throw new Error("Unknown workspace root.");
  }

  const rootRelativePath = normalizeRelativePath(qualifiedPath.relativePath).replace(/^\/+/, "");
  return {
    absolutePath: safeResolveProjectPath(root.root, rootRelativePath),
    displayPath: formatWorkspaceQualifiedPath(root.id, rootRelativePath),
    gitRoot: root.root,
    root,
    rootRelativePath,
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

export async function assertProjectFileCanBeDeleted(filePath: string, rootDir = projectRoot) {
  const absoluteFilePath = safeResolveProjectPath(rootDir, filePath);
  const stats = await fs.stat(absoluteFilePath);
  if (!stats.isFile()) {
    throw new Error("Only files can be deleted from the project explorer.");
  }
}

export async function deleteProjectFile(filePath: string, rootDir = projectRoot) {
  await assertProjectFileCanBeDeleted(filePath, rootDir);
  const absoluteFilePath = safeResolveProjectPath(rootDir, filePath);
  await fs.unlink(absoluteFilePath);
}

export async function buildTree(
  currentDir = projectRoot,
  gitignoreMatcher?: (relativePath: string) => boolean,
): Promise<TreeNode[]> {
  const shouldIgnorePath = gitignoreMatcher ?? (await createProjectGitignoreMatcher(projectRoot));
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
      if (shouldIgnorePath(relativePath)) {
        continue;
      }

      children.push({
        type: "directory",
        name: entry.name,
        path: relativePath,
        children: await buildTree(absolutePath, shouldIgnorePath),
      });
      continue;
    }

    children.push({
      ...(shouldIgnorePath(relativePath) ? { isIgnored: true } : {}),
      type: "file",
      name: entry.name,
      path: relativePath,
    });
  }

  return children;
}

export async function buildProjectTree(
  rootDir: string,
  currentDir = rootDir,
  gitignoreMatcher?: (relativePath: string) => boolean,
): Promise<TreeNode[]> {
  const shouldIgnorePath = gitignoreMatcher ?? (await createProjectGitignoreMatcher(rootDir));
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
      if (shouldIgnorePath(relativePath)) {
        continue;
      }

      children.push({
        type: "directory",
        name: entry.name,
        path: relativePath,
        children: await buildProjectTree(rootDir, absolutePath, shouldIgnorePath),
      });
      continue;
    }

    children.push({
      ...(shouldIgnorePath(relativePath) ? { isIgnored: true } : {}),
      type: "file",
      name: entry.name,
      path: relativePath,
    });
  }

  return children;
}

function qualifyTreeNodePaths(root: ResolvedProjectRoot, nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    const qualifiedPath = formatWorkspaceQualifiedPath(root.id, node.path);
    if (node.type === "file") {
      return {
        ...node,
        path: qualifiedPath,
      };
    }

    return {
      ...node,
      path: qualifiedPath,
      children: qualifyTreeNodePaths(root, node.children),
    };
  });
}

async function buildWorkspaceTree(project: ResolvedProject) {
  const rootTrees = await Promise.all(project.roots.map(async (root) => ({
    root,
    tree: await buildProjectTree(root.root),
  })));

  return rootTrees.map(({ root, tree }) => ({
    type: "directory" as const,
    name: root.name,
    path: formatWorkspaceQualifiedPath(root.id, ""),
    children: qualifyTreeNodePaths(root, tree),
  }));
}

async function getProjectChanges(project: ResolvedProject) {
  if (project.kind === "workbench-library") {
    return {};
  }

  if (project.kind !== "workspace") {
    return await getGitChanges(project.root);
  }

  const changesByRoot = await Promise.all(project.roots.map(async (root) => ({
    root,
    changes: await getGitChanges(root.root),
  })));

  return Object.fromEntries(changesByRoot.flatMap(({ root, changes }) => (
    Object.entries(changes).map(([filePath, change]) => [formatWorkspaceQualifiedPath(root.id, filePath), change])
  )));
}

export async function getProjectSnapshot(projectId?: string | null) {
  return await getProjectSnapshotFromResolvedProject(await resolveProjectRoot(projectId));
}

export async function getProjectSnapshotFromResolvedProject(resolvedProject: ResolvedProject) {
  const [tree, changes] = await Promise.all([
    resolvedProject.kind === "workspace" ? buildWorkspaceTree(resolvedProject) : buildProjectTree(resolvedProject.root),
    getProjectChanges(resolvedProject),
  ]);
  return {
    projectId: resolvedProject.id,
    root: resolvedProject.kind === "workspace"
      ? resolvedProject.id
      : resolvedProject.kind === "git"
        ? resolvedProject.roots[0]?.name ?? path.basename(resolvedProject.root)
        : path.basename(resolvedProject.root),
    rootPath: normalizeRelativePath(resolvedProject.root),
    roots: toProjectSnapshotRoots(resolvedProject),
    tree,
    changes,
    workbenchStorageRootPath: normalizeRelativePath(projectRoot),
  } satisfies ProjectSnapshot;
}

export async function listProjectSkills(projectId?: string | null): Promise<WorkbenchSkillSummary[]> {
  const resolvedProject = await resolveProjectRoot(projectId);
  if (resolvedProject.id === WORKBENCH_LIBRARY_PROJECT_ID) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(getProjectSkillDirectoryPath(resolvedProject.root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const skills: WorkbenchSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const relativePath = createProjectSkillRelativePath(entry.name);
    const absolutePath = safeResolveProjectPath(resolvedProject.root, relativePath);
    const content = await readTextFile(absolutePath);
    if (!content) {
      continue;
    }

    const frontmatter = parseFrontmatterBlock(content);
    skills.push({
      description: frontmatter?.get("description") ?? "",
      name: frontmatter?.get("name") ?? entry.name,
      path: normalizeRelativePath(absolutePath),
      relativePath,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export async function listProjectSkillDefinitions(projectId?: string | null): Promise<WorkbenchSkillDefinition[]> {
  const resolvedProject = await resolveProjectRoot(projectId);
  if (resolvedProject.id === WORKBENCH_LIBRARY_PROJECT_ID) {
    return [];
  }

  return await listProjectSkillDefinitionsFromRoot(resolvedProject.root);
}

export async function listProjectSkillDefinitionsFromRoot(rootDir: string): Promise<WorkbenchSkillDefinition[]> {
  let entries;
  try {
    entries = await fs.readdir(getProjectSkillDirectoryPath(rootDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const skills: WorkbenchSkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const relativePath = createProjectSkillRelativePath(entry.name);
    const absolutePath = safeResolveProjectPath(rootDir, relativePath);
    const content = await readTextFile(absolutePath);
    if (!content?.trim()) {
      continue;
    }

    const frontmatter = parseFrontmatterBlock(content);
    skills.push({
      content: content.trim(),
      description: frontmatter?.get("description") ?? "",
      name: frontmatter?.get("name") ?? entry.name,
      path: normalizeRelativePath(absolutePath),
      relativePath,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export async function listUserInvocableAgents(projectId?: string | null) {
  return await listUserInvocableAgentsFromResolvedProject(await resolveProjectRoot(projectId));
}

export async function listUserInvocableAgentsFromResolvedProject(resolvedProject: ResolvedProject) {
  const libraryAgents = await listWorkbenchLibraryAgents();
  if (resolvedProject.id === WORKBENCH_LIBRARY_PROJECT_ID) {
    return libraryAgents;
  }

  const projectAgents: WorkbenchAgentOption[] = [];
  try {
    const entries = await fs.readdir(getAgentDirectoryPath(resolvedProject.root), { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !isAgentMarkdownFile(entry.name)) {
        continue;
      }

      const relativePath = createAgentRelativePath(entry.name);
      const content = await readAgentFile(resolvedProject.root, relativePath);
      const frontmatter = parseFrontmatterBlock(content);
      if (!isAgentUserInvocable(frontmatter)) {
        continue;
      }

      projectAgents.push({
        name: frontmatter?.get("name") ?? getAgentNameFromFileName(entry.name),
        description: frontmatter?.get("description") ?? "",
        path: relativePath,
        source: "project",
        sourceLabel: "Project",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return libraryAgents;
    }

    throw error;
  }

  return [...libraryAgents, ...projectAgents.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))];
}

export async function readUserInvocableAgentDefinition(relativePath: string, projectId?: string | null): Promise<WorkbenchAgentDefinition> {
  if (relativePath.startsWith("library:")) {
    return await readWorkbenchLibraryAgentDefinition(relativePath);
  }

  const resolvedProject = await resolveProjectRoot(projectId);
  return await readUserInvocableAgentDefinitionFromRoot(relativePath, resolvedProject.root);
}

export async function readUserInvocableAgentDefinitionFromRoot(relativePath: string, rootDir: string): Promise<WorkbenchAgentDefinition> {
  if (relativePath.startsWith("library:")) {
    return await readWorkbenchLibraryAgentDefinition(relativePath);
  }

  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath.startsWith(".agents/agents/") || !isAgentMarkdownFile(normalizedPath)) {
    throw new Error("Agent path is outside the supported agents directory.");
  }

  const content = await readAgentFile(rootDir, normalizedPath);
  const frontmatter = parseFrontmatterBlock(content);
  if (!isAgentUserInvocable(frontmatter)) {
    throw new Error("Agent is not user-invocable.");
  }

  const prompt = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return {
    description: frontmatter?.get("description") ?? "",
    name: frontmatter?.get("name") ?? getAgentNameFromFileName(path.basename(normalizedPath)),
    path: normalizedPath,
    prompt,
    source: "project",
    sourceLabel: "Project",
  };
}
