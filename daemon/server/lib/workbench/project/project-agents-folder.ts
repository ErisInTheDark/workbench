/*
 * Exports:
 * - listProjectSkillsFromRoot: project skills with the gitignored `.agents.local` overlay replacing same-named `.agents` skills, plus tombstoned names.
 * - listUserInvocableAgentsFromResolvedProject: library agents followed by overlaid project agents under canonical `.agents/agents/` paths.
 * - readUserInvocableAgentDefinitionFromRoot: read a library agent, or a project agent from `.agents.local` before `.agents`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchAgentDefinition, WorkbenchAgentOption } from "workbench-shared/types";
import { normalizeRelativePath, safeResolveProjectPath, type ResolvedProject } from "../../project";
import {
  getAgentNameFromFileName,
  isAgentMarkdownFile,
  isAgentUserInvocable,
  listWorkbenchLibraryAgents,
  parseFrontmatterBlock,
  readWorkbenchLibraryAgentDefinition,
  stripWorkbenchInstructionFrontmatter,
  WORKBENCH_LIBRARY_PROJECT_ID,
} from "../../workbench-library";
import { listSkillDefinitionsFromDirectory, type WorkbenchProjectSkills } from "../skills/skill-discovery";

const PROJECT_FOLDER = ".agents";
const LOCAL_FOLDER = ".agents.local";
const AGENTS_DIRECTORY = `${PROJECT_FOLDER}/agents/`;
const TOMBSTONE_SUFFIX = ".tombstone";

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listTombstoneNames(directoryPath: string) {
  return new Set((await readDirectoryEntries(directoryPath))
    .filter(entry => entry.isFile() && entry.name.toLocaleLowerCase().endsWith(TOMBSTONE_SUFFIX))
    .map(entry => entry.name.slice(0, -TOMBSTONE_SUFFIX.length).toLocaleLowerCase()));
}

export async function listProjectSkillsFromRoot(rootDir: string): Promise<WorkbenchProjectSkills> {
  const [localSkills, hiddenNames, projectSkills] = await Promise.all([
    listSkillDefinitionsFromDirectory(rootDir, `${LOCAL_FOLDER}/skills`, parseFrontmatterBlock),
    listTombstoneNames(path.join(rootDir, LOCAL_FOLDER, "skills")),
    listSkillDefinitionsFromDirectory(rootDir, `${PROJECT_FOLDER}/skills`, parseFrontmatterBlock),
  ]);
  return { skills: [...localSkills, ...projectSkills], hiddenNames: [...hiddenNames] };
}

function toLocalPath(projectRelativePath: string) {
  return `${LOCAL_FOLDER}${projectRelativePath.slice(PROJECT_FOLDER.length)}`;
}

function agentKey(fileName: string) {
  return getAgentNameFromFileName(fileName).toLocaleLowerCase();
}

/** Canonical `.agents/agents/` path of each visible agent file, with the source path its content comes from. */
async function listProjectAgentFiles(rootDir: string) {
  const [localEntries, projectEntries, hiddenNames] = await Promise.all([
    readDirectoryEntries(path.join(rootDir, LOCAL_FOLDER, "agents")),
    readDirectoryEntries(path.join(rootDir, PROJECT_FOLDER, "agents")),
    listTombstoneNames(path.join(rootDir, LOCAL_FOLDER, "agents")),
  ]);
  const seenKeys = new Set(hiddenNames);
  const files: { canonicalPath: string; fileName: string; sourcePath: string }[] = [];
  for (const [entries, folder] of [[localEntries, LOCAL_FOLDER], [projectEntries, PROJECT_FOLDER]] as const) {
    for (const entry of entries) {
      if (!entry.isFile() || !isAgentMarkdownFile(entry.name) || seenKeys.has(agentKey(entry.name))) continue;
      seenKeys.add(agentKey(entry.name));
      files.push({
        canonicalPath: `${AGENTS_DIRECTORY}${entry.name}`,
        fileName: entry.name,
        sourcePath: `${folder}/agents/${entry.name}`,
      });
    }
  }
  return files;
}

async function readProjectAgentContent(rootDir: string, canonicalPath: string) {
  const localPath = toLocalPath(canonicalPath);
  const hiddenNames = await listTombstoneNames(path.dirname(safeResolveProjectPath(rootDir, localPath)));
  if (hiddenNames.has(agentKey(path.posix.basename(canonicalPath)))) {
    throw new Error("Agent is hidden by a .agents.local tombstone.");
  }

  try {
    return await fs.readFile(safeResolveProjectPath(rootDir, localPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return await fs.readFile(safeResolveProjectPath(rootDir, canonicalPath), "utf8");
}

export async function listUserInvocableAgentsFromResolvedProject(resolvedProject: ResolvedProject) {
  const libraryAgents = await listWorkbenchLibraryAgents();
  if (resolvedProject.id === WORKBENCH_LIBRARY_PROJECT_ID) {
    return libraryAgents;
  }

  const projectAgents: WorkbenchAgentOption[] = [];
  for (const file of await listProjectAgentFiles(resolvedProject.root)) {
    const frontmatter = parseFrontmatterBlock(await fs.readFile(safeResolveProjectPath(resolvedProject.root, file.sourcePath), "utf8"));
    if (!isAgentUserInvocable(frontmatter)) continue;
    projectAgents.push({
      name: frontmatter?.get("name") ?? getAgentNameFromFileName(file.fileName),
      description: frontmatter?.get("description") ?? "",
      path: file.canonicalPath,
      source: "project",
      sourceLabel: "Project",
    });
  }

  return [...libraryAgents, ...projectAgents.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))];
}

export async function readUserInvocableAgentDefinitionFromRoot(relativePath: string, rootDir: string): Promise<WorkbenchAgentDefinition> {
  if (relativePath.startsWith("library:")) {
    return await readWorkbenchLibraryAgentDefinition(relativePath);
  }

  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath.startsWith(AGENTS_DIRECTORY) || !isAgentMarkdownFile(normalizedPath)) {
    throw new Error("Agent path is outside the supported agents directory.");
  }

  const content = await readProjectAgentContent(rootDir, normalizedPath);
  const frontmatter = parseFrontmatterBlock(content);
  if (!isAgentUserInvocable(frontmatter)) {
    throw new Error("Agent is not user-invocable.");
  }

  return {
    description: frontmatter?.get("description") ?? "",
    name: frontmatter?.get("name") ?? getAgentNameFromFileName(path.basename(normalizedPath)),
    path: normalizedPath,
    prompt: stripWorkbenchInstructionFrontmatter(content),
    source: "project",
    sourceLabel: "Project",
  };
}
