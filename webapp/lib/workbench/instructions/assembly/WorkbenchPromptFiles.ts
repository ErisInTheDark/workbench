/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions: public prompt assembly contracts. Keywords: prompt, context, instructions.
 * - ensureWorkbenchPromptFiles: write generated Workbench prompt files and scaffold prompt folders. Keywords: AGENTS, workflows, default agent.
 * - buildWorkbenchPromptInstructions: resolve fresh prompt files and expand Workbench injections. Keywords: prompt, injections, app-server.
 * - buildWorkbenchThreadUtilityDeveloperInstructions: resolve workflow-free typed Workbench instructions. Keywords: thread, utilities, MCP.
 * - buildWorkbenchCollaborationDeveloperInstructions: build Workbench-owned questionnaire collaboration instructions. Keywords: collaboration, plan mode.
 * - buildWorkbenchGitInstructions: re-export managed Git instruction rendering. Keywords: git, arc, checkpoint.
 * - filterWorkbenchInstructionContent/listWorkbenchInstructionMechanics: re-export final selector filtering and mechanic availability. Keywords: selector, mechanics.
 * - default WorkbenchPromptFiles: prompt-file assembly owner namespace. Keywords: prompt, owner, generated files.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  listProjectSkillDefinitionsFromRoot,
  readUserInvocableAgentDefinitionFromRoot,
} from "../../../project";
import type {
  WorkbenchAgentDefinition,
  WorkbenchProjectRoot,
} from "../../../types";
import {
  buildWorkbenchSkillManifestInstructions,
  listWorkbenchLibraryInstructions,
  parseFrontmatterBlock,
} from "../../../workbench-library";
import {
  normalizeWorkbenchLibraryPath,
  safeResolveWorkbenchLibraryPath,
  workbenchLibraryRoot,
} from "../../../workbench-library-paths";
import {
  isWorkbenchLibraryAgentPath,
  normalizeWorkbenchAgentPath,
} from "../../agent-paths";
import { WORKBENCH_INJECTION_TEMPLATES } from "../injections/workbench-injection-registry";
import {
  buildWorkbenchBrowseInstructions,
  buildWorkbenchGitInstructions,
  buildWorkbenchLongWaitInstructions,
  buildWorkbenchOrchestratorReloadInstructions,
  buildWorkbenchSubagentInstructions,
  buildWorkbenchThreadRecallInstructions,
  buildWorkbenchThreadResumeInstructions,
  buildThreadStatusInstructions,
  listWorkbenchInstructionMechanics,
} from "../mechanics/workbench-instruction-mechanics";
import { buildThreadTitleInstructions } from "../mechanics/workbench-thread-title-instructions";
import { filterWorkbenchInstructionContent } from "../selectors/instruction-context-filter";
import {
  WORKBENCH_AGENT_DEFAULT_PROMPT,
  WORKBENCH_AGENT_DEFAULT_TEMPLATE_PROMPT,
  WORKBENCH_AGENTS_PROMPT,
  WORKBENCH_AGENTS_TEMPLATE_PROMPT,
  WORKBENCH_COLLABORATION_MODE_INSTRUCTIONS,
  WORKBENCH_WORKFLOW_DEFAULT_PROMPT,
  WORKBENCH_WORKFLOW_DEFAULT_TEMPLATE_PROMPT,
  WORKBENCH_WORKFLOW_SUBAGENT_PROMPT,
  WORKBENCH_WORKFLOW_SUBAGENT_TEMPLATE_PROMPT,
} from "./workbench-prompt-sources";
import type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";

export type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";
export {
  buildWorkbenchGitInstructions,
  filterWorkbenchInstructionContent,
  listWorkbenchInstructionMechanics,
};

interface ActiveMarkdownFile {
  readonly content: string;
  readonly key: string;
  readonly path: string;
}

const AGENTS_FILE_NAME = "AGENTS.md";
const AGENTS_OVERRIDE_FILE_NAME = "AGENTS.override.md";
const AGENTS_TEMPLATE_FILE_NAME = "AGENTS.template.md";
const DEFAULT_AGENT_FILE_NAME = "agents/default.md";
const DEFAULT_AGENT_TEMPLATE_FILE_NAME = "agents/default.template.md";
const TEMPLATE_FILE_SUFFIX = ".template.md";
const OVERRIDE_FILE_SUFFIX = ".override.md";
const MARKDOWN_FILE_SUFFIX = ".md";
const GENERATED_WORKFLOW_FILES = [
  {
    content: WORKBENCH_WORKFLOW_DEFAULT_PROMPT,
    path: "workflows/DEFAULT.md",
  },
  {
    content: WORKBENCH_WORKFLOW_DEFAULT_TEMPLATE_PROMPT,
    path: "workflows/DEFAULT.template.md",
  },
  {
    content: WORKBENCH_WORKFLOW_SUBAGENT_PROMPT,
    path: "workflows/SUBAGENT.md",
  },
  {
    content: WORKBENCH_WORKFLOW_SUBAGENT_TEMPLATE_PROMPT,
    path: "workflows/SUBAGENT.template.md",
  },
] as const;

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeContent(value: string) {
  return `${normalizeLineEndings(value).trim()}\n`;
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeGeneratedFile(relativePath: string, content: string) {
  const absolutePath = safeResolveWorkbenchLibraryPath(relativePath);
  const normalizedContent = normalizeContent(content);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const currentContent = await readTextFile(absolutePath);
  if (currentContent !== null && normalizeContent(currentContent) === normalizedContent) {
    return;
  }

  await fs.writeFile(absolutePath, normalizedContent, "utf8");
}

async function writeFileIfMissing(relativePath: string, content: string) {
  const absolutePath = safeResolveWorkbenchLibraryPath(relativePath);
  try {
    await fs.access(absolutePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, normalizeContent(content), "utf8");
}

function isTemplateMarkdownFile(fileName: string) {
  return fileName.endsWith(TEMPLATE_FILE_SUFFIX);
}

function getActiveMarkdownFileKey(fileName: string) {
  if (isTemplateMarkdownFile(fileName) || !fileName.endsWith(MARKDOWN_FILE_SUFFIX)) {
    return null;
  }

  const basename = fileName.endsWith(OVERRIDE_FILE_SUFFIX)
    ? fileName.slice(0, -OVERRIDE_FILE_SUFFIX.length)
    : fileName.slice(0, -MARKDOWN_FILE_SUFFIX.length);
  return basename.trim().toLowerCase() || null;
}

function isOverrideMarkdownFile(fileName: string) {
  return fileName.endsWith(OVERRIDE_FILE_SUFFIX);
}

async function listActiveMarkdownFiles(relativeDirectory: string): Promise<ActiveMarkdownFile[]> {
  const absoluteDirectory = safeResolveWorkbenchLibraryPath(relativeDirectory);
  let entries;
  try {
    entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const byKey = new Map<string, { entryName: string; override: boolean }>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const key = getActiveMarkdownFileKey(entry.name);
    if (!key) {
      continue;
    }

    const override = isOverrideMarkdownFile(entry.name);
    const existing = byKey.get(key);
    if (!existing || override || (!existing.override && entry.name.localeCompare(existing.entryName) < 0)) {
      byKey.set(key, {
        entryName: entry.name,
        override,
      });
    }
  }

  const files: ActiveMarkdownFile[] = [];
  for (const [key, selected] of Array.from(byKey.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const relativePath = normalizeWorkbenchLibraryPath(path.join(relativeDirectory, selected.entryName));
    const content = await readTextFile(safeResolveWorkbenchLibraryPath(relativePath));
    if (!content?.trim()) {
      continue;
    }

    files.push({
      content: normalizeLineEndings(content).trim(),
      key,
      path: safeResolveWorkbenchLibraryPath(relativePath),
    });
  }

  return files;
}

function stripFrontmatter(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function getAgentNameFromFileName(fileName: string) {
  return fileName.replace(/\.md$/i, "");
}

function toAgentDisplayPath(agentPath: string) {
  const normalizedPath = normalizeWorkbenchLibraryPath(agentPath);
  if (normalizedPath.startsWith("agent://")) {
    return normalizedPath;
  }

  const withoutLibraryPrefix = normalizedPath.startsWith("library:")
    ? normalizedPath.slice("library:".length)
    : normalizedPath;
  const fileName = path.posix.basename(withoutLibraryPrefix.replace(/^\/+/, ""));
  return `agent://${fileName || "default.md"}`;
}

function getPrimaryPromptRoot(context: WorkbenchPromptContext) {
  return context.roots?.find((root) => root.isPrimary) ?? context.roots?.[0] ?? null;
}

async function readDefaultAgentDefinition(): Promise<WorkbenchAgentDefinition> {
  const absolutePath = safeResolveWorkbenchLibraryPath(DEFAULT_AGENT_FILE_NAME);
  const content = await readTextFile(absolutePath) ?? WORKBENCH_AGENT_DEFAULT_PROMPT;
  const frontmatter = parseFrontmatterBlock(content);
  return {
    description: frontmatter?.get("description") ?? "",
    name: frontmatter?.get("name") ?? getAgentNameFromFileName(path.basename(DEFAULT_AGENT_FILE_NAME)),
    path: DEFAULT_AGENT_FILE_NAME,
    prompt: stripFrontmatter(content),
    source: "library",
    sourceLabel: "Workbench Library",
  };
}

async function readSelectedAgentDefinition(context: WorkbenchPromptContext) {
  const selectedAgentPath = normalizeWorkbenchAgentPath(context.agentPath);
  if (!selectedAgentPath) {
    return await readDefaultAgentDefinition();
  }

  try {
    const promptRoot = getPrimaryPromptRoot(context);
    if (!isWorkbenchLibraryAgentPath(selectedAgentPath) && !promptRoot?.rootPath.trim()) {
      throw new Error("No project root was supplied for the selected project agent.");
    }

    return await readUserInvocableAgentDefinitionFromRoot(selectedAgentPath, promptRoot?.rootPath ?? "");
  } catch (error) {
    throw new Error(
      `Unable to load selected Workbench agent "${selectedAgentPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function buildAgentDefinitionInjection(agentDefinition: WorkbenchAgentDefinition) {
  const displayPath = toAgentDisplayPath(agentDefinition.path);
  return WORKBENCH_INJECTION_TEMPLATES["agent.definition"].injection
    .replaceAll("{agent.name}", agentDefinition.name)
    .replaceAll("{agent.path}", displayPath)
    .replaceAll("{agent.description}", agentDefinition.description)
    .replaceAll("{agent.prompt}", agentDefinition.prompt.trim());
}

function escapeXmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildSubagentIdentityInjection(context: WorkbenchPromptContext) {
  const name = context.subagentName?.trim();
  return name
    ? WORKBENCH_INJECTION_TEMPLATES["subagent.identity"].injection.replaceAll("{subagent.name}", escapeXmlText(name))
    : "";
}

function formatWorkspaceRoots(roots: readonly WorkbenchProjectRoot[] | null | undefined) {
  if (!roots?.length) {
    return "- No workspace roots were supplied by Workbench for this thread.";
  }

  return roots
    .map((root) => `- ${root.id}: ${root.rootPath}${root.isPrimary ? " (primary cwd for new threads)" : ""}`)
    .join("\n");
}

function buildWorkbenchSkillsInjection(skillManifest: string | null) {
  return WORKBENCH_INJECTION_TEMPLATES["workbench.skills"].injection
    .replaceAll("{workbench.skills}", skillManifest?.trim() || "No additional Workbench skills were detected.");
}

function buildWorkbenchSkillsDeveloperInstructions(skillManifest: string | null) {
  return skillManifest?.trim()
    ? buildWorkbenchSkillsInjection(skillManifest)
    : null;
}

function buildWorkspaceRootsInjection(context: WorkbenchPromptContext) {
  return WORKBENCH_INJECTION_TEMPLATES["workspace.roots"].injection
    .replaceAll("{workspace.roots}", formatWorkspaceRoots(context.roots));
}

async function buildWorkflowInjection(context: WorkbenchPromptContext) {
  const activeWorkflowIds = new Set((context.workflowIds ?? []).map((workflowId) => workflowId.trim().toLowerCase()).filter(Boolean));
  const workflows = await listActiveMarkdownFiles("workflows");
  const selectedWorkflows = activeWorkflowIds.size
    ? workflows.filter((workflow) => activeWorkflowIds.has(workflow.key))
    : [];
  const workflowScopedInjections: Record<string, string> = {
    "workbench.rendering": WORKBENCH_INJECTION_TEMPLATES["workbench.rendering"].injection,
    "workbench.tools": WORKBENCH_INJECTION_TEMPLATES["workbench.tools"].injection,
    "workspace.roots": buildWorkspaceRootsInjection(context),
    ...(context.instructionInjections ?? {}),
  };
  const workflowContent = selectedWorkflows.length
    ? selectedWorkflows.map((workflow) => [
      `## ${workflow.key}`,
      `Source: ${workflow.path}`,
      expandInstructionInjections(workflow.content, workflowScopedInjections),
    ].join("\n")).join("\n\n")
    : "No active Workbench workflow is selected for this thread.";

  return WORKBENCH_INJECTION_TEMPLATES["workflow.active"].injection
    .replaceAll("{workflow.content}", workflowContent);
}

function expandInstructionInjections(content: string, injections: Record<string, string>) {
  return content.replace(/\{([a-z][a-z0-9 .-]*)\}/gi, (match, id: string) => {
    const normalizedId = id.trim().toLowerCase().replace(/\s+/g, ".");
    return injections[normalizedId] ?? match;
  });
}

function buildInstructionPackSections(instructions: readonly { content: string; name: string; path: string }[]) {
  const sections = instructions
    .map((instructionPack) => [
      `## ${instructionPack.name}`,
      `Source: ${instructionPack.path}`,
      instructionPack.content.trim(),
    ].join("\n"));

  if (!sections.length) {
    return null;
  }

  return [
    "Workbench provides these universal instruction packs from the Workbench Library. Treat them as Workbench-provided developer instructions for this thread.",
    ...sections,
  ].join("\n\n");
}

async function readActiveBasePrompt() {
  const overrideContent = await readTextFile(safeResolveWorkbenchLibraryPath(AGENTS_OVERRIDE_FILE_NAME));
  if (overrideContent?.trim()) {
    return normalizeLineEndings(overrideContent).trim();
  }

  const generatedContent = await readTextFile(safeResolveWorkbenchLibraryPath(AGENTS_FILE_NAME));
  return generatedContent?.trim()
    ? normalizeLineEndings(generatedContent).trim()
    : WORKBENCH_AGENTS_PROMPT;
}

function joinInstructionSections(sections: Array<string | null | undefined>) {
  return sections
    .map((section) => section?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n") || null;
}

async function listProjectSkillDefinitionsForPrompt(context: WorkbenchPromptContext) {
  const promptRoot = getPrimaryPromptRoot(context);
  if (!promptRoot?.rootPath.trim()) {
    return [];
  }

  return await listProjectSkillDefinitionsFromRoot(promptRoot.rootPath);
}

function buildInjectionManifest() {
  return Object.entries(WORKBENCH_INJECTION_TEMPLATES)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, template]) => {
      const spaceAlias = id.replaceAll(".", " ");
      const aliasText = spaceAlias === id ? "" : ` Alias: {${spaceAlias}}.`;
      return `- {${id}}: ${template.description}${aliasText}`;
    })
    .join("\n");
}

function buildAgentsTemplatePrompt() {
  return WORKBENCH_AGENTS_TEMPLATE_PROMPT
    .replaceAll("{injection.manifest}", buildInjectionManifest());
}

export async function ensureWorkbenchPromptFiles() {
  await fs.mkdir(workbenchLibraryRoot, { recursive: true });
  await Promise.all([
    fs.mkdir(safeResolveWorkbenchLibraryPath("agents"), { recursive: true }),
    fs.mkdir(safeResolveWorkbenchLibraryPath("instructions"), { recursive: true }),
    fs.mkdir(safeResolveWorkbenchLibraryPath("skills"), { recursive: true }),
    fs.mkdir(safeResolveWorkbenchLibraryPath("workflows"), { recursive: true }),
  ]);

  await Promise.all([
    writeGeneratedFile(AGENTS_FILE_NAME, WORKBENCH_AGENTS_PROMPT),
    writeGeneratedFile(AGENTS_TEMPLATE_FILE_NAME, buildAgentsTemplatePrompt()),
    writeGeneratedFile(DEFAULT_AGENT_TEMPLATE_FILE_NAME, WORKBENCH_AGENT_DEFAULT_TEMPLATE_PROMPT),
    writeFileIfMissing(DEFAULT_AGENT_FILE_NAME, WORKBENCH_AGENT_DEFAULT_PROMPT),
    ...GENERATED_WORKFLOW_FILES.map((file) => writeGeneratedFile(file.path, file.content)),
  ]);
}

export async function buildWorkbenchPromptInstructions(context: WorkbenchPromptContext = {}): Promise<WorkbenchPromptInstructions> {
  await ensureWorkbenchPromptFiles();

  const [basePrompt, agentDefinition, projectSkills, workflowInjection, instructionPacks, browseInstructions] = await Promise.all([
    readActiveBasePrompt(),
    readSelectedAgentDefinition(context),
    listProjectSkillDefinitionsForPrompt(context),
    buildWorkflowInjection(context),
    listWorkbenchLibraryInstructions(),
    buildWorkbenchBrowseInstructions(context),
  ]);
  const skillManifest = await buildWorkbenchSkillManifestInstructions(projectSkills);

  const injections: Record<string, string> = {
    "agent.definition": buildAgentDefinitionInjection(agentDefinition),
    "subagent.identity": buildSubagentIdentityInjection(context),
    "workbench.rendering": WORKBENCH_INJECTION_TEMPLATES["workbench.rendering"].injection,
    "workbench.skills": buildWorkbenchSkillsInjection(skillManifest),
    "workbench.tools": WORKBENCH_INJECTION_TEMPLATES["workbench.tools"].injection,
    "workflow.active": workflowInjection,
    "workspace.roots": buildWorkspaceRootsInjection(context),
  };

  const baseInstructions = expandInstructionInjections(basePrompt, injections).trim();
  const developerInstructions = joinInstructionSections([
    buildWorkbenchSkillsDeveloperInstructions(skillManifest),
    buildInstructionPackSections(instructionPacks),
    browseInstructions,
    buildWorkbenchLongWaitInstructions(context),
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadRecallInstructions(context),
    buildWorkbenchThreadResumeInstructions(context),
    buildWorkbenchGitInstructions(context),
    buildWorkbenchSubagentInstructions(context),
    buildThreadTitleInstructions(context),
    buildThreadStatusInstructions(context),
  ]);

  return {
    baseInstructions: baseInstructions || null,
    developerInstructions,
  };
}

export async function buildWorkbenchThreadUtilityDeveloperInstructions(
  context: WorkbenchPromptContext = {},
): Promise<string | null> {
  await ensureWorkbenchPromptFiles();

  const browseInstructions = await buildWorkbenchBrowseInstructions(context);
  return joinInstructionSections([
    browseInstructions,
    buildWorkbenchLongWaitInstructions(context),
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadRecallInstructions(context),
    buildWorkbenchThreadResumeInstructions(context),
    buildWorkbenchGitInstructions(context),
    buildWorkbenchSubagentInstructions(context),
    buildThreadTitleInstructions(context),
    buildThreadStatusInstructions(context),
  ]);
}

export async function buildWorkbenchCollaborationDeveloperInstructions(
  context: WorkbenchPromptContext = {},
): Promise<string | null> {
  await ensureWorkbenchPromptFiles();

  const [agentDefinition, workflowInjection, browseInstructions] = await Promise.all([
    readSelectedAgentDefinition(context),
    buildWorkflowInjection(context),
    buildWorkbenchBrowseInstructions(context),
  ]);

  return joinInstructionSections([
    WORKBENCH_COLLABORATION_MODE_INSTRUCTIONS
      .replaceAll("{{agent.name}}", agentDefinition.name)
      .replaceAll("{{agent.path}}", toAgentDisplayPath(agentDefinition.path)),
    WORKBENCH_INJECTION_TEMPLATES["workbench.tools"].injection,
    WORKBENCH_INJECTION_TEMPLATES["workbench.rendering"].injection,
    buildWorkspaceRootsInjection(context),
    workflowInjection,
    browseInstructions,
    buildWorkbenchLongWaitInstructions(context),
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadRecallInstructions(context),
    buildWorkbenchThreadResumeInstructions(context),
    buildWorkbenchGitInstructions(context),
    buildWorkbenchSubagentInstructions(context),
    buildThreadTitleInstructions(context),
    buildThreadStatusInstructions(context),
  ]);
}

const WorkbenchPromptFiles = {
  buildWorkbenchCollaborationDeveloperInstructions,
  buildWorkbenchGitInstructions,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
