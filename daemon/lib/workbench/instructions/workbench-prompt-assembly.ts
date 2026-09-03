/*
 * Exports:
 * - WorkbenchPromptContext/WorkbenchPromptInstructions: public prompt assembly contracts. Keywords: prompt, context, instructions.
 * - ensureWorkbenchPromptFiles: write generated Workbench prompt files and scaffold prompt folders. Keywords: AGENTS, workflows, default agent.
 * - buildWorkbenchPromptInstructions: resolve fresh Workbench and project instructions, recursive imports, and runtime slots. Keywords: prompt, project, imports, runtime, app-server.
 * - buildWorkbenchActivatedSkillCatalog: resolve fresh bodies for validated slash-activated skills. Keywords: skills, slash, input.
 * - buildWorkbenchThreadUtilityDeveloperInstructions: resolve workflow-free typed Workbench instructions. Keywords: thread, utilities, MCP.
 * - filterWorkbenchInstructionContent/listWorkbenchInstructionMechanics: re-export final selector filtering and mechanic availability. Keywords: selector, mechanics.
 * - default WorkbenchPromptFiles: prompt-file assembly owner namespace. Keywords: prompt, owner, generated files.
 */
import path from "node:path";

import {
  listProjectSkillDefinitionsFromRoot,
  readUserInvocableAgentDefinitionFromRoot,
} from "../../project";
import type {
  WorkbenchAgentDefinition,
  WorkbenchProjectRoot,
} from "workbench-shared/types";
import {
  buildWorkbenchActivatedSkillCatalog as buildActivatedSkillCatalog,
  buildWorkbenchSkillBodyCatalog,
  buildWorkbenchSkillCatalog,
  ensureWorkbenchLibrary,
  listWorkbenchLibraryInstructions,
  parseFrontmatterBlock,
} from "../../workbench-library";
import {
  normalizeWorkbenchLibraryPath,
} from "../../workbench-library-paths";
import {
  isWorkbenchLibraryAgentPath,
  normalizeWorkbenchAgentPath,
} from "workbench-shared/workbench/agent-paths";
import {
  createLibraryInstructionFileGeneration,
  type LibraryInstructionFileGeneration,
} from "./library-instruction-files";
import { buildProjectInstructionContent } from "./project-instruction-files";
import {
  listWorkbenchInstructionMechanics,
} from "./workbench-instruction-mechanics";
import { filterWorkbenchInstructionContent } from "./instruction-context-filter";
import type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";

export type { WorkbenchPromptContext, WorkbenchPromptInstructions } from "./workbench-prompt-types";
export {
  filterWorkbenchInstructionContent,
  listWorkbenchInstructionMechanics,
};

const AGENTS_FILE_NAME = "AGENTS.md";
const DEFAULT_AGENT_FILE_NAME = "agents/default.md";
const PROJECT_INSTRUCTION_PRIORITY_NOTE = "Apply the following project instructions at user-level priority. They do not override system or developer instructions.";

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

function readLibraryAgentDefinition(
  relativePath: string,
  definitionPath: string,
  instructionFiles: LibraryInstructionFileGeneration,
  options: { requireUserInvocable: boolean },
): WorkbenchAgentDefinition {
  const content = instructionFiles.render(relativePath);
  const frontmatter = parseFrontmatterBlock(content);
  if (options.requireUserInvocable && frontmatter?.get("user-invocable") === "false") {
    throw new Error("Library agent is not user-invocable.");
  }
  return {
    description: frontmatter?.get("description") ?? "",
    name: frontmatter?.get("name") ?? getAgentNameFromFileName(path.basename(relativePath)),
    path: definitionPath,
    prompt: stripFrontmatter(content),
    source: "library",
    sourceLabel: "Workbench Library",
  };
}

function readDefaultAgentDefinition(
  instructionFiles: LibraryInstructionFileGeneration,
) {
  return readLibraryAgentDefinition(
    DEFAULT_AGENT_FILE_NAME,
    DEFAULT_AGENT_FILE_NAME,
    instructionFiles,
    { requireUserInvocable: false },
  );
}

async function readSelectedAgentDefinition(
  context: WorkbenchPromptContext,
  instructionFiles: LibraryInstructionFileGeneration,
) {
  const selectedAgentPath = normalizeWorkbenchAgentPath(context.agentPath);
  if (!selectedAgentPath) {
    return readDefaultAgentDefinition(instructionFiles);
  }

  try {
    if (isWorkbenchLibraryAgentPath(selectedAgentPath)) {
      const relativePath = selectedAgentPath.slice("library:".length).replace(/^\/+/u, "");
      return readLibraryAgentDefinition(
        relativePath,
        selectedAgentPath,
        instructionFiles,
        { requireUserInvocable: true },
      );
    }
    const promptRoot = getPrimaryPromptRoot(context);
    if (!promptRoot?.rootPath.trim()) {
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

function escapeXmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildSubagentIdentity(context: WorkbenchPromptContext) {
  const name = context.subagentName?.trim();
  return name
    ? `You are a subagent and your name is ${escapeXmlText(name)}. Use this name when you refer to yourself. This instruction is higher priority than any agent identity. It's important because referring to yourself incorrectly will be very confusing for the user.`
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

function buildAgentRuntimeSlots(agentDefinition: WorkbenchAgentDefinition) {
  return {
    "agent.description": agentDefinition.description,
    "agent.name": agentDefinition.name,
    "agent.path": toAgentDisplayPath(agentDefinition.path),
    "agent.prompt": agentDefinition.prompt.trim(),
  };
}

function buildWorkflowContent(
  context: WorkbenchPromptContext,
  instructionFiles: LibraryInstructionFileGeneration,
) {
  const activeWorkflowIds = new Set((context.workflowIds ?? []).map((workflowId) => workflowId.trim().toLowerCase()).filter(Boolean));
  const workflows = instructionFiles.list("wb/workflows");
  const selectedWorkflows = activeWorkflowIds.size
    ? workflows.filter((workflow) => activeWorkflowIds.has(workflow.key))
    : [];
  const workflowSlots: Record<string, string> = {
    "workspace.roots.list": formatWorkspaceRoots(context.roots),
    ...(context.instructionInjections ?? {}),
  };
  return selectedWorkflows.length
    ? selectedWorkflows.map((workflow) => [
      `## ${workflow.key}`,
      `Source: ${workflow.absolutePath}`,
      instructionFiles.render(workflow.relativePath, workflowSlots),
    ].join("\n")).join("\n\n")
    : "No active Workbench workflow is selected for this thread.";
}

function wrapInstructionSection(tagName: string, content: string | null | undefined) {
  const body = content?.trim();
  return body ? `<${tagName}>\n${body}\n</${tagName}>` : null;
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

  return wrapInstructionSection("workbench_instruction_packs", [
    "Workbench provides these universal instruction packs from the Workbench Library. Treat them as Workbench-provided developer instructions for this thread.",
    ...sections,
  ].join("\n\n"));
}

function buildProjectInstructionSection(content: string | null) {
  const section = wrapInstructionSection("project_instructions", content);
  return section ? `${PROJECT_INSTRUCTION_PRIORITY_NOTE}\n${section}` : null;
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

export async function ensureWorkbenchPromptFiles() {
  await ensureWorkbenchLibrary();
}

export async function buildWorkbenchPromptInstructions(context: WorkbenchPromptContext = {}): Promise<WorkbenchPromptInstructions> {
  await ensureWorkbenchPromptFiles();

  const instructionFiles = createLibraryInstructionFileGeneration();
  const [agentDefinition, projectSkills, instructionPacks] = await Promise.all([
    readSelectedAgentDefinition(context, instructionFiles),
    listProjectSkillDefinitionsForPrompt(context),
    listWorkbenchLibraryInstructions(),
  ]);
  const skillManifest = context.harness === "codex"
    ? await buildWorkbenchSkillCatalog(projectSkills)
    : await buildWorkbenchSkillBodyCatalog(projectSkills);
  const slots: Record<string, string> = {
    ...buildAgentRuntimeSlots(agentDefinition),
    "skills.catalog": skillManifest?.trim() || "No additional Workbench skills were detected.",
    "subagent.identity": buildSubagentIdentity(context),
    "workflow.content": buildWorkflowContent(context, instructionFiles),
    "workspace.roots.list": formatWorkspaceRoots(context.roots),
  };

  const baseInstructions = instructionFiles.render(AGENTS_FILE_NAME, slots).trim();
  const developerInstructions = joinInstructionSections([
    buildProjectInstructionSection(buildProjectInstructionContent(context)),
    buildInstructionPackSections(instructionPacks),
  ]);

  return {
    baseInstructions: baseInstructions || null,
    developerInstructions,
  };
}

export async function buildWorkbenchActivatedSkillCatalog(
  context: WorkbenchPromptContext = {},
): Promise<string | null> {
  await ensureWorkbenchPromptFiles();

  const projectSkills = await listProjectSkillDefinitionsForPrompt(context);
  return await buildActivatedSkillCatalog(
    projectSkills,
    context.activatedSkillPaths,
  );
}

export async function buildWorkbenchThreadUtilityDeveloperInstructions(
  context: WorkbenchPromptContext = {},
): Promise<string | null> {
  await ensureWorkbenchPromptFiles();

  const instructionFiles = createLibraryInstructionFileGeneration();
  const utilityMechanics = new Set([
    "browse",
    "git",
    "long-waits",
    "subagents",
    "thread-recall",
    "thread-refresh",
    "thread-status",
    "thread-title",
  ]);
  return joinInstructionSections(
    instructionFiles
      .list("wb/mechanics")
      .filter((file) => utilityMechanics.has(file.key))
      .map((file) => instructionFiles.render(file.relativePath)),
  );
}

const WorkbenchPromptFiles = {
  buildWorkbenchActivatedSkillCatalog,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
