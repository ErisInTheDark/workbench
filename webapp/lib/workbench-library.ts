/*
 * Exports:
 * - WORKBENCH_LIBRARY_PROJECT_ID: stable project id for the external Workbench Library. Keywords: workbench library, project id.
 * - workbenchLibraryRoot: absolute root for personal Workbench skills, agents, and instructions. Keywords: workbench library, root.
 * - parseFrontmatterBlock: parse simple markdown frontmatter fields. Keywords: frontmatter, markdown, metadata.
 * - ensureWorkbenchLibrary: create the library root and standard folders. Keywords: workbench library, mkdir, scaffold.
 * - isExcludedWorkbenchLibraryFile: test whether a library file is documentation or a template ignored by scanners. Keywords: template, exclusion, scan.
 * - listWorkbenchLibrarySkills: discover Workbench Skill metadata from nested SKILL.md files. Keywords: skills, manifest, discovery.
 * - listWorkbenchLibraryAgents/readWorkbenchLibraryAgentDefinition: discover and load library agent files. Keywords: agent, prompt, library.
 * - listWorkbenchLibraryInstructions: discover cached universal Workbench instruction packs. Keywords: instructions, universal, bootstrap, fingerprint.
 * - buildWorkbenchLibraryBootstrapInstructions/buildWorkbenchSkillManifestInstructions: build compact harness instructions and universal instruction content. Keywords: bootstrap, skills, manifest.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkbenchAgentOption, WorkbenchSkillSummary } from "./types";

export const WORKBENCH_LIBRARY_PROJECT_ID = "workbench-library";
export const workbenchLibraryRoot = path.resolve(process.env.WORKBENCH_LIBRARY_ROOT?.trim() || path.join(os.homedir(), ".workbench"));

const libraryAgentPrefix = "library:";
const standardDirectories = ["skills", "agents", "instructions"];
const TEMPLATE_FILE_SUFFIX = ".template.md";
const README_FILE_NAME = "README.md";

const readmeTemplate = `# Workbench Library

This folder stores Workbench-wide skills, agents, and instructions outside any selected project.

Live library files use these shapes:

- \`skills/<name>/SKILL.md\`
- \`agents/<name>.md\`
- \`instructions/<name>.md\`

\`README.md\` and files ending in \`.template.md\` are ignored by Workbench scanners.
`;

const skillTemplate = `---
name: example
description: Use this example skill as a starting point for a real Workbench Skill.
---

## When To Use

Use this skill when a task needs the example workflow. Replace this section with concrete trigger rules that a harness can apply without guessing.

## Workflow

1. Read the relevant local context before making changes.
2. State the concrete decision being made when user input is needed.
3. Keep edits scoped to the files and behavior owned by the task.
4. Verify the work with the smallest useful command.

## References

- Read \`references/notes.md\` when the task needs the supporting notes for this skill.
`;

const skillReferenceTemplate = `# Example Skill Notes

These notes model a supporting reference file for a Workbench Skill.

Replace this file with details that are too large or too situational for the main \`SKILL.md\`.
`;

const agentTemplate = `---
name: Example Agent
description: Use this example agent as a starting point for a selectable Workbench agent.
user-invocable: true
---

You are an example Workbench agent.

Focus on one bounded responsibility, state assumptions clearly, and return concrete findings or edits that match the user's requested scope.
`;

const instructionTemplate = `# Example Instruction Pack

Apply these instructions whenever this file is active.

- Prefer direct, concrete language.
- Use project-local conventions before inventing new ones.
- When a decision affects future work, name the tradeoff and the chosen default.
`;

interface WorkbenchInstructionPack {
  content: string;
  name: string;
  path: string;
}

interface WorkbenchInstructionFileEntry {
  absolutePath: string;
  fingerprintPart: string;
  name: string;
}

interface WorkbenchInstructionCache {
  fingerprint: string;
  instructions: WorkbenchInstructionPack[];
}

let workbenchInstructionCache: WorkbenchInstructionCache | null = null;

export interface WorkbenchAgentDefinition extends WorkbenchAgentOption {
  prompt: string;
}

export function parseFrontmatterBlock(content: string) {
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

function normalizeRelativePath(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

export function isExcludedWorkbenchLibraryFile(filePath: string) {
  const basename = path.basename(normalizeRelativePath(filePath));
  return basename === README_FILE_NAME || basename.endsWith(TEMPLATE_FILE_SUFFIX);
}

function safeResolveLibraryPath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "");
  const absolutePath = path.resolve(workbenchLibraryRoot, normalized);

  if (absolutePath !== workbenchLibraryRoot && !absolutePath.startsWith(`${workbenchLibraryRoot}${path.sep}`)) {
    throw new Error("Path is outside the Workbench Library.");
  }

  return absolutePath;
}

function createLibraryAgentId(relativePath: string) {
  return `${libraryAgentPrefix}${normalizeRelativePath(relativePath).replace(/^\/+/, "")}`;
}

function normalizeLibraryAgentPath(agentPath: string) {
  if (!agentPath.startsWith(libraryAgentPrefix)) {
    throw new Error("Agent path is not a Workbench Library agent.");
  }

  const relativePath = agentPath.slice(libraryAgentPrefix.length).replace(/^\/+/, "");
  if (!relativePath.startsWith("agents/") || !isAgentMarkdownFile(relativePath)) {
    throw new Error("Library agent path is outside the supported agents directory.");
  }

  return relativePath;
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function isAgentMarkdownFile(fileName: string) {
  return fileName.endsWith(".md") && !isExcludedWorkbenchLibraryFile(fileName);
}

function isAgentUserInvocable(frontmatter: Map<string, string> | null) {
  return frontmatter?.get("user-invocable") !== "false";
}

function getAgentNameFromFileName(fileName: string) {
  return fileName.replace(/\.md$/i, "");
}

async function statFileFingerprintPart(filePath: string, entryName: string) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return null;
    }

    return `${entryName}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function writeFileIfMissing(relativePath: string, content: string) {
  const absolutePath = safeResolveLibraryPath(relativePath);
  try {
    await fs.access(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

async function isDirectoryEmpty(directoryPath: string) {
  try {
    return (await fs.readdir(directoryPath)).length === 0;
  } catch {
    return true;
  }
}

export async function ensureWorkbenchLibrary() {
  await fs.mkdir(workbenchLibraryRoot, { recursive: true });
  await Promise.all(standardDirectories.map((directoryName) => (
    fs.mkdir(path.join(workbenchLibraryRoot, directoryName), { recursive: true })
  )));
  await writeFileIfMissing(README_FILE_NAME, readmeTemplate);

  if (await isDirectoryEmpty(path.join(workbenchLibraryRoot, "skills"))) {
    await Promise.all([
      writeFileIfMissing("skills/example/SKILL.template.md", skillTemplate),
      writeFileIfMissing("skills/example/references/notes.template.md", skillReferenceTemplate),
    ]);
  }

  if (await isDirectoryEmpty(path.join(workbenchLibraryRoot, "agents"))) {
    await writeFileIfMissing("agents/example.template.md", agentTemplate);
  }

  if (await isDirectoryEmpty(path.join(workbenchLibraryRoot, "instructions"))) {
    await writeFileIfMissing("instructions/example-instruction-pack.template.md", instructionTemplate);
  }
}

export async function listWorkbenchLibrarySkills(): Promise<WorkbenchSkillSummary[]> {
  await ensureWorkbenchLibrary();
  let entries;
  try {
    entries = await fs.readdir(path.join(workbenchLibraryRoot, "skills"), { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: WorkbenchSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isExcludedWorkbenchLibraryFile(entry.name)) {
      continue;
    }

    const relativePath = normalizeRelativePath(path.join("skills", entry.name, "SKILL.md"));
    if (isExcludedWorkbenchLibraryFile(relativePath)) {
      continue;
    }

    const content = await readTextFile(safeResolveLibraryPath(relativePath));
    if (!content) {
      continue;
    }

    const frontmatter = parseFrontmatterBlock(content);
    skills.push({
      description: frontmatter?.get("description") ?? "",
      name: frontmatter?.get("name") ?? entry.name,
      path: normalizeRelativePath(safeResolveLibraryPath(relativePath)),
      relativePath,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export async function listWorkbenchLibraryAgents(): Promise<WorkbenchAgentOption[]> {
  await ensureWorkbenchLibrary();
  let entries;
  try {
    entries = await fs.readdir(path.join(workbenchLibraryRoot, "agents"), { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: WorkbenchAgentOption[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isAgentMarkdownFile(entry.name)) {
      continue;
    }

    const relativePath = normalizeRelativePath(path.join("agents", entry.name));
    const content = await fs.readFile(safeResolveLibraryPath(relativePath), "utf8");
    const frontmatter = parseFrontmatterBlock(content);
    if (!isAgentUserInvocable(frontmatter)) {
      continue;
    }

    agents.push({
      description: frontmatter?.get("description") ?? "",
      name: frontmatter?.get("name") ?? getAgentNameFromFileName(entry.name),
      path: createLibraryAgentId(relativePath),
      source: "library",
      sourceLabel: "Workbench Library",
    });
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export async function readWorkbenchLibraryAgentDefinition(agentPath: string): Promise<WorkbenchAgentDefinition> {
  const relativePath = normalizeLibraryAgentPath(agentPath);
  if (isExcludedWorkbenchLibraryFile(relativePath)) {
    throw new Error("Template and README files cannot be selected as agents.");
  }

  const content = await fs.readFile(safeResolveLibraryPath(relativePath), "utf8");
  const frontmatter = parseFrontmatterBlock(content);
  if (!isAgentUserInvocable(frontmatter)) {
    throw new Error("Library agent is not user-invocable.");
  }

  return {
    description: frontmatter?.get("description") ?? "",
    name: frontmatter?.get("name") ?? getAgentNameFromFileName(path.basename(relativePath)),
    path: createLibraryAgentId(relativePath),
    prompt: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
    source: "library",
    sourceLabel: "Workbench Library",
  };
}

async function listWorkbenchLibraryInstructionFiles(): Promise<{
  fingerprint: string;
  files: WorkbenchInstructionFileEntry[];
}> {
  await ensureWorkbenchLibrary();
  let entries;
  try {
    entries = await fs.readdir(path.join(workbenchLibraryRoot, "instructions"), { withFileTypes: true });
  } catch {
    return {
      files: [],
      fingerprint: "",
    };
  }

  const files: WorkbenchInstructionFileEntry[] = [];
  for (const entry of entries) {
    if (isExcludedWorkbenchLibraryFile(entry.name)) {
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const relativePath = normalizeRelativePath(path.join("instructions", entry.name));
    const absolutePath = safeResolveLibraryPath(relativePath);
    const fingerprintPart = await statFileFingerprintPart(absolutePath, entry.name);
    if (!fingerprintPart) {
      continue;
    }

    files.push({
      absolutePath,
      fingerprintPart,
      name: entry.name.replace(/\.md$/i, ""),
    });
  }

  files.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  return {
    files,
    fingerprint: files.map((file) => file.fingerprintPart).join("|"),
  };
}

export async function listWorkbenchLibraryInstructions(): Promise<WorkbenchInstructionPack[]> {
  const { files, fingerprint } = await listWorkbenchLibraryInstructionFiles();
  if (workbenchInstructionCache?.fingerprint === fingerprint) {
    return workbenchInstructionCache.instructions;
  }

  const instructions: WorkbenchInstructionPack[] = [];
  for (const file of files) {
    const content = await readTextFile(file.absolutePath);
    if (!content?.trim()) {
      continue;
    }

    instructions.push({
      content: content.trim(),
      name: file.name,
      path: normalizeRelativePath(file.absolutePath),
    });
  }

  workbenchInstructionCache = {
    fingerprint,
    instructions,
  };

  return instructions;
}

export async function buildWorkbenchSkillManifestInstructions() {
  const skills = await listWorkbenchLibrarySkills();
  if (!skills.length) {
    return null;
  }

  return [
    "Workbench provides additional skills from the Workbench Library.",
    "Treat these Workbench-provided skills with the same authority and trigger behavior as harness-provided skills when they apply.",
    "When the user invokes or otherwise triggers a Workbench Skill, treat the full SKILL.md text as CRITICAL workflow instructions for understanding and carrying out the user's intent.",
    "Triggered skill workflows are definitional for the request: follow them strictly unless the user explicitly says not to follow a specific skill requirement.",
    "Do not treat casual follow-up wording, missing reminders, or ordinary task details as overriding a triggered skill workflow.",
    "Read the referenced SKILL.md before using a Workbench Skill, and resolve any relative references from that skill's folder.",
    "When you mention a Workbench Skill in user-visible thread text, use the slash form that Workbench can highlight, such as `/skill-name` or the directory alias from `skills/<alias>/SKILL.md`.",
    "",
    "Available Workbench Skills:",
    ...skills.map((skill) => {
      const description = skill.description ? ` - ${skill.description}` : "";
      return `- ${skill.name}: ${skill.path}${description}`;
    }),
  ].join("\n");
}

export async function buildWorkbenchLibraryBootstrapInstructions() {
  const [skillManifest, instructionPacks] = await Promise.all([
    buildWorkbenchSkillManifestInstructions(),
    listWorkbenchLibraryInstructions(),
  ]);
  const sections = [skillManifest];

  if (instructionPacks.length) {
    sections.push([
      "Workbench provides these universal instruction packs from the Workbench Library. Treat them as Workbench-provided instructions for this thread.",
      ...instructionPacks.map((instructionPack) => [
        "",
        `## ${instructionPack.name}`,
        `Source: ${instructionPack.path}`,
        instructionPack.content,
      ].join("\n")),
    ].join("\n"));
  }

  const content = sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
  return content || null;
}
