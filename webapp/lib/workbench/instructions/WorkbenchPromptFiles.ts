/*
 * Exports:
 * - WorkbenchPromptContext: Workbench-private context used to resolve Codex prompt instructions. Keywords: prompt, context, codex.
 * - WorkbenchPromptInstructions: resolved base and developer instruction payload. Keywords: prompt, baseInstructions, developerInstructions.
 * - ensureWorkbenchPromptFiles: write generated Workbench prompt files and scaffold prompt folders. Keywords: AGENTS, workflows, default agent.
 * - buildWorkbenchPromptInstructions: resolve fresh prompt files and expand Workbench injections for a Codex thread. Keywords: prompt, injections, app-server.
 * - buildWorkbenchThreadUtilityDeveloperInstructions: resolve workflow-free Workbench CLI instructions. Keywords: checkpoints, thread title, thread context, cli.
 * - buildWorkbenchCollaborationDeveloperInstructions: build Workbench-owned questionnaire collaboration instructions. Keywords: collaboration mode, plan mode, request_user_input.
 * - default WorkbenchPromptFiles: prompt-file owner namespace. Keywords: prompt, owner, generated files.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
    listProjectSkillDefinitionsFromRoot,
    readUserInvocableAgentDefinitionFromRoot,
} from "../../project";
import { buildThreadTitleBootstrapInstructions } from "../../thread-bootstrap";
import type {
    WorkbenchAgentDefinition,
    WorkbenchHarness,
    WorkbenchProjectRoot,
} from "../../types";
import {
    buildWorkbenchSkillManifestInstructions,
    listWorkbenchLibraryInstructions,
    parseFrontmatterBlock,
} from "../../workbench-library";
import {
    normalizeWorkbenchLibraryPath,
    safeResolveWorkbenchLibraryPath,
    workbenchLibraryRoot,
} from "../../workbench-library-paths";
import {
    isWorkbenchLibraryAgentPath,
    normalizeWorkbenchAgentPath,
} from "../agent-paths";
import WorkbenchServerSettings from "../settings/WorkbenchServerSettings";
import { WORKBENCH_INJECTION_TEMPLATES } from "./instruction-injections";
import {
    WORKBENCH_AGENT_DEFAULT_PROMPT,
    WORKBENCH_AGENT_DEFAULT_TEMPLATE_PROMPT,
    WORKBENCH_AGENTS_PROMPT,
    WORKBENCH_AGENTS_TEMPLATE_PROMPT,
    WORKBENCH_WORKFLOW_COLLABORATOR_PROMPT,
    WORKBENCH_WORKFLOW_COLLABORATOR_TEMPLATE_PROMPT,
    WORKBENCH_WORKFLOW_DEFAULT_PROMPT,
    WORKBENCH_WORKFLOW_DEFAULT_TEMPLATE_PROMPT,
    WORKBENCH_WORKFLOW_SUBAGENT_PROMPT,
    WORKBENCH_WORKFLOW_SUBAGENT_TEMPLATE_PROMPT,
} from "./workbench-base-prompts";

export interface WorkbenchPromptContext {
  readonly agentPath?: string | null;
  readonly harness?: WorkbenchHarness | null;
  readonly instructionScope?: "full" | "threadUtilities";
  readonly instructionInjections?: Readonly<Record<string, string>>;
  readonly projectId?: string | null;
  readonly roots?: readonly WorkbenchProjectRoot[];
  readonly threadId?: string | null;
  readonly workbenchOrigin?: string | null;
  readonly workflowIds?: readonly string[];
}

export interface WorkbenchPromptInstructions {
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
}

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
    content: WORKBENCH_WORKFLOW_COLLABORATOR_PROMPT,
    path: "workflows/COLLABORATOR.md",
  },
  {
    content: WORKBENCH_WORKFLOW_COLLABORATOR_TEMPLATE_PROMPT,
    path: "workflows/COLLABORATOR.template.md",
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

function buildThreadTitleInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return buildThreadTitleBootstrapInstructions({
    harness: context.harness ?? "codex",
    threadId,
  });
}

async function buildWorkbenchBrowseInstructions(context: WorkbenchPromptContext) {
  if (!context.workbenchOrigin?.trim()) {
    return null;
  }
  let rawCommandStatus = "Raw Browse CLI-args passthrough is currently disabled.";
  try {
    const settings = new WorkbenchServerSettings();
    const localCapabilities = await settings.readLocalCapabilities();
    rawCommandStatus = localCapabilities.browseRawCommandsEnabled
      ? "Raw Browse CLI-args passthrough is currently enabled."
      : "Raw Browse CLI-args passthrough is currently disabled.";
  } catch {
    rawCommandStatus = "Raw Browse CLI-args passthrough status could not be read; assume it is disabled unless the user confirms otherwise.";
  }

  // NOTE: This section only advertises the CLI capability and points to the built-in skill for its workflow.
  return `
## Workbench Browse CLI

Workbench provides the allowlisted \`wb browse\` command family for browser automation only when the user, an active workflow, or another active instruction asks for browser work.

${rawCommandStatus}

This section does not authorize arbitrary Workbench requests. Use the \`/browse\` skill for the browser workflow and command contract, including when listing or stopping Workbench-known Browse sessions.

Each \`wb browse\` call must stay isolated and auditable. Do not bundle it with unrelated shell work, page-data transformation, branching, or cleanup outside the BrowseMD request. If Browse output needs processing, run the Browse command visibly first, then process its visible result separately.
`.trim();
}

function buildWorkbenchOrchestratorReloadInstructions(context: WorkbenchPromptContext) {
  if (!context.workbenchOrigin?.trim()) {
    return null;
  }

  return `
## Workbench Orchestrator Reload CLI

Workbench exposes reload scopes only through the allowlisted \`wb orchestrator reload\` command. Add any required scopes as independent switches in one invocation:

\`wb orchestrator reload [--orchestrator-logic] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]\`

At least one switch is required. The command waits for terminal reload status and tolerates the temporary connection loss caused by \`--next-dev\`.

Reloads preserve lifecycle ownership: \`--codex-bridge\` reloads bridge-side code without restarting the stable Codex app-server; \`--opencode-server\` explicitly restarts the managed OpenCode server; \`--next-dev\` restarts Next.js. Do not request broader scopes than the work requires.
`.trim();
}

function buildWorkbenchThreadContextReorientationInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return `
## Workbench Thread Context Reorientation

After context compaction, run this Workbench CLI command before continuing:

\`wb thread context --thread ${threadId}\`

Use the returned Markdown to recover the latest user messages, steers, plan blocks, and questionnaire answers; then inspect the relevant files before editing. This command is authorized only for post-compaction reorientation and does not replace approval, file checks, or checkpoint checks.
`.trim();
}

function buildWorkbenchCheckpointInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return `
## Workbench Git Checkpoints

Workbench supports hidden Git checkpoints for agent workflow baselines through the \`wb checkpoint\` command family. Checkpoints are real local Git commit objects stored under per-worktree refs, not visible branch commits.

This thread's checkpoint namespace is owned by Workbench and scoped to the current Git worktree:

\`\`\`text
refs/worktree/agents/${threadId}/checkpoints
\`\`\`

Checkpoint refs are convenience state, not a security boundary. Do not use them to store secrets unless the repo state is already allowed to contain those secrets.

Use these exact CLI shapes so Workbench can match and render checkpoint operations. Workbench owns the Git plumbing and uses a temporary index internally, so agents should not run raw \`git update-ref\` checkpoint scripts themselves.

### Create a baseline checkpoint

Run after entering Brief mode for an approved-plan baseline; call this returned checkpoint commit the approval checkpoint. Also run in Implement mode after the start-of-implementation checkpoint diff is classified safe and before the first file edit; call that returned checkpoint commit the initial implementation checkpoint for the current implementation arc.

\`wb checkpoint baseline --thread ${threadId}\`

### Diff against a specific checkpoint

Run immediately after entering Implement mode before editing by passing the approval checkpoint commit. Run again after entering Review mode before summarizing changes by passing the initial implementation checkpoint commit for the current implementation arc. Do not omit \`checkpointCommit\`, do not substitute the newest checkpoint, and do not guess from thread history; parallel agents may create unrelated newer checkpoints. The command output is a compact checkpoint diff summary for agent review. Workbench stores the full unified diff separately and renders it for the user in the UI.

\`wb checkpoint diff --thread ${threadId} --commit <checkpoint-commit-sha>\`

### Diff a specific file against a specific checkpoint

Use after the compact checkpoint diff when a changed file may dangerously intersect with the approved edit files, nearby ownership, contracts, dependencies, validation scope, branch/HEAD, or mechanics needed by the plan. Use the same \`checkpointCommit\` as the compact diff you are investigating. Replace \`<repo-relative-path>\` with a changed file path from that compact summary. The command returns that file's unified diff only.

\`wb checkpoint file-diff --thread ${threadId} --commit <checkpoint-commit-sha> --file <repo-relative-path>\`

### Create a diff checkpoint

Do not run this as part of normal Review mode. Use only when the user explicitly asks to preserve the current state as a checkpoint.

\`wb checkpoint create-diff --thread ${threadId}\`

### Restore a checkpoint after explicit user request

Only restore when the user asks for a checkpoint restore. First run the diff command or another preview. Restore uses a checkpoint commit sha supplied by the user or selected from the thread's checkpoint output. The CLI requires \`--confirm\`, and Workbench blocks when the checkpoint parent is not the current HEAD.

\`wb checkpoint restore --thread ${threadId} --commit <checkpoint-commit-sha> --confirm\`
`.trim();
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
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadContextReorientationInstructions(context),
    buildWorkbenchCheckpointInstructions(context),
    buildThreadTitleInstructions(context),
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
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadContextReorientationInstructions(context),
    buildWorkbenchCheckpointInstructions(context),
    buildThreadTitleInstructions(context),
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
    `
## Workbench Collaboration Mode

Workbench may use Codex app-server Plan Mode only as a transport/capability mode to enable request_user_input for Workbench workflows.

Do not treat app-server Plan Mode as a prohibition on approved file edits or implementation. File modification is governed by the active Workbench workflow, user approval, sandbox permissions, and project instructions.

If an active workflow enters Implement mode after explicit approval, approved implementation may proceed even though the app-server collaboration mode is named plan.

This collaboration-mode overlay must not replace the active Workbench workflow, project instructions, selected agent identity, or latest user approvals. Continue following the selected Workbench agent identity: ${agentDefinition.name} (${toAgentDisplayPath(agentDefinition.path)}).
`,
    WORKBENCH_INJECTION_TEMPLATES["workbench.tools"].injection,
    WORKBENCH_INJECTION_TEMPLATES["workbench.rendering"].injection,
    buildWorkspaceRootsInjection(context),
    workflowInjection,
    browseInstructions,
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadContextReorientationInstructions(context),
    buildWorkbenchCheckpointInstructions(context),
    buildThreadTitleInstructions(context),
  ]);
}

const WorkbenchPromptFiles = {
  buildWorkbenchCollaborationDeveloperInstructions,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
};

export default WorkbenchPromptFiles;
