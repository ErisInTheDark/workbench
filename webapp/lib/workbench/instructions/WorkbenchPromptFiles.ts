/*
 * Exports:
 * - WorkbenchPromptContext: Workbench-private context used to resolve Codex prompt instructions. Keywords: prompt, context, codex.
 * - WorkbenchPromptInstructions: resolved base and developer instruction payload. Keywords: prompt, baseInstructions, developerInstructions.
 * - ensureWorkbenchPromptFiles: write generated Workbench prompt files and scaffold prompt folders. Keywords: AGENTS, workflows, default agent.
 * - buildWorkbenchPromptInstructions: resolve fresh prompt files and expand Workbench injections for a Codex thread. Keywords: prompt, injections, app-server.
 * - buildWorkbenchThreadUtilityDeveloperInstructions: resolve workflow-free Workbench CLI instructions. Keywords: checkpoints, thread title, thread recall, cli.
 * - filterWorkbenchInstructionContent: render final instruction fields for the trusted harness, shell, and available mechanics. Keywords: selector, filter, final payload.
 * - listWorkbenchInstructionMechanics: derive mechanics availability from the same packet predicates used by prompt assembly. Keywords: selector, available, mechanics.
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
import { filterWorkbenchInstructionContent } from "./instruction-context-filter";
import { WORKBENCH_INJECTION_TEMPLATES } from "./instruction-injections";
import {
    WORKBENCH_AGENT_DEFAULT_PROMPT,
    WORKBENCH_AGENT_DEFAULT_TEMPLATE_PROMPT,
    WORKBENCH_AGENTS_PROMPT,
    WORKBENCH_AGENTS_TEMPLATE_PROMPT,
    WORKBENCH_WORKFLOW_DEFAULT_PROMPT,
    WORKBENCH_WORKFLOW_DEFAULT_TEMPLATE_PROMPT,
    WORKBENCH_WORKFLOW_SUBAGENT_PROMPT,
    WORKBENCH_WORKFLOW_SUBAGENT_TEMPLATE_PROMPT,
} from "./workbench-base-prompts";

export { filterWorkbenchInstructionContent };

export interface WorkbenchPromptContext {
  readonly agentPath?: string | null;
  readonly harness?: WorkbenchHarness | null;
  readonly instructionScope?: "full" | "threadUtilities";
  readonly instructionInjections?: Readonly<Record<string, string>>;
  readonly projectId?: string | null;
  readonly roots?: readonly WorkbenchProjectRoot[];
  readonly subagentName?: string | null;
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

function isMaterializedPromptThread(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  return Boolean(threadId && threadId !== "new" && !threadId.startsWith("draft:") && context.workbenchOrigin?.trim());
}

export function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext) {
  const available = new Set<string>();
  if (context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("orchestrator-reload");
    available.add("subagents");
  }
  if (isMaterializedPromptThread(context)) {
    available.add("thread-git");
    available.add("thread-recall");
    available.add("thread-status");
    if (!context.subagentName?.trim()) available.add("thread-title");
  }
  return available;
}

function buildThreadTitleInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || context.subagentName?.trim() || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return buildThreadTitleBootstrapInstructions({
    harness: context.harness ?? "codex",
    threadId,
  });
}

function buildThreadStatusInstructions(context: WorkbenchPromptContext) {
  if (!isMaterializedPromptThread(context)) return null;
  return `
## Workbench Thread Status CLI

Thread status tells Workbench whether the current turn is finished or needs attention:

\`wb thread status --status <completed|blocked>\`
`.trim();
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

Workbench exposes reload scopes only through the allowlisted \`wb orchestrator reload\` command. Add any required scopes as independent switches in one invocation, or use the safe broad convenience switch:

\`wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]\`

At least one switch is required. The command waits for terminal reload status and tolerates the temporary connection loss caused by \`--next-dev\`.

\`--all\` selects orchestrator logic, Browse controller, Codex bridge, OpenCode bridge, and Next.js. It never replaces the orchestrator process and intentionally excludes managed-server replacement: \`--opencode-server\` must always be requested explicitly.

Reloads preserve lifecycle ownership: \`--browse-controller\` drains and reloads orchestrator-owned Browse execution without restarting browser sessions; \`--codex-bridge\` reloads bridge-side code without restarting the stable Codex app-server; \`--opencode-server\` explicitly restarts the managed OpenCode server; \`--next-dev\` restarts Next.js. Do not request broader scopes than the work requires.
`.trim();
}

function buildWorkbenchSubagentInstructions(context: WorkbenchPromptContext) {
  if (!context.workbenchOrigin?.trim()) return null;
  return `
## Workbench Subagent CLI

Workbench owns subagents exclusively through the allowlisted \`wb subagent\` command suite. No other subagent tools are approved.
Run every command from the intended project cwd; the CLI privately supplies that cwd and the current managed thread identity.

### Managing subagents
\`wb subagent list\` lists every unsettled direct child.

\`wb subagent list --settled [--cursor <cursor>] [--limit <1-20>]\` lists settled history.

\`wb subagent profiles\` lists profiles available to this thread. Use a profile ID only as the machine value for \`--profile\`. When talking to the user, always use the profile's user-facing \`name\`, never its ID.

\`wb subagent create --profile <profile-id> --name <name> --title <title> --message <message>\` creates and starts a child. Every flag is required. Choose a unique, person-like name the user can use conversationally. Let your active agent identity influence the name, but do not use a task slug, role label, or operation codename; \`--title\` owns the task description. Workbench preserves display spelling and resolves names case-insensitively.

When replacing a superseded child, choose a new person-like name. Do not append \`2\`, \`II\`, or another version suffix to the old name.

### Waiting for subagents
\`wb subagent wait --name <name> [--name <name>...]\` waits until the first target needs attention, completes, or stops.

Pass every active child in one wait command instead of building separate parallel waits. Treat the command as a blocking event wait, not as a polling primitive. Use a 25-minute shell timeout and keep the outer execution tool attached for the complete wait. A wait timeout cancels only that wait request, not any child turn.

Do not hide waits behind \`Promise.all\`, let an outer wrapper yield into a cell and repeatedly poll that cell with generic \`functions.wait\`, or substitute generic sleeping or idling. Those shapes conceal child questionnaires and completions behind unrelated work.

Do not include pointless "anxiety commentary" between waits. We include a timeout on waits solely to allow user steers a chance to arrive. Workbench automatically combines waits in the log, but if you're interleaving waits with noisy commentary, this compression does not happen.

Use this command shape when \`functions.exec\` owns the shell call:

\`\`\`\`js
// @exec: {"yield_time_ms": 1505000, "max_output_tokens": 5000}
const result = await tools.shell_command({
  command: "wb subagent wait --name <first-name> --name <second-name>",
  workdir: "<project cwd>",
  timeout_ms: 1500000,
});
text(result);
\`\`\`\`

\`wb subagent message --name <name> --message <message>\` sends ordinary prose to an unsettled direct child as a steer. When no turn is active, it starts a new turn.

\`wb subagent message --parent --message <message>\` lets a direct child send info to its direct parent.

\`wb subagent stop --name <name> [--name <name>...]\` stops any number of unsettled direct children.

\`wb subagent settle --name <name> [--name <name>...]\` settles Completed or Stopped children and releases their names for reuse.

<shell:pwsh>
For a multiline create or message value in PowerShell, use a literal single-quoted here-string:

\`\`\`\`powershell
wb subagent message --name <name> --message @'
first line
second line
'@
\`\`\`\`
</shell:pwsh>

<shell:bash>
For a multiline create or message value in Bash, use a quoted heredoc:

\`\`\`\`bash
wb subagent message --name <name> --message "$(cat <<'EOF'
first line
second line
EOF
)"
\`\`\`\`
</shell:bash>

The returned subagent ID is its thread ID and can be used with Workbench Thread Recall. You may operate only on direct children owned by the current thread; sideways and grandchild access fails closed.

### Subagent notes & recipes
- The wait command is the only way to receive a subagent's final output. Do not leave them hanging with no wait.
- Without explicit instruction, subagents communicate through commentary (not visible to you). If you need to get preliminary info from a subagent before completion, ask it specifically to message you with what you need using the \`wb subagent message --parent\` command.
- Subagents are entirely isolated, they do not inherit any context of the parent or sibling threads. Prompts must be self-contained. Do not poison subagents by telling them to do or not to do <thing they don't know anything about>, they WILL hallucinate.
- Do not blindly trust subagent output. Subagents are often less intelligent models.
- When you are orchestrating subagent review passes, you must orchestrate STRONGLY and DELIBERATELY against infinite review loops and scope creep. You are responsible for getting the implementation or plan to an acceptable state as defined by the user or project requirements in a reasonable time frame. If you don't plan, prompt, or implement effectively, subagents will continue to find additional work to do endlessly.
`.trim();
}

function buildWorkbenchThreadRecallInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return `
## Workbench Thread Recall

After context compaction, run this Workbench CLI command before continuing:

\`wb thread recall --thread ${threadId}\`

The default command returns the newest bounded page of chronological narrative history. Filter it with repeatable \`--kind <kind>\` flags; the emitted HTML tag names are the exact available kinds: \`user-message\`, \`user-steer\`, \`questionnaire\`, \`commentary\`, \`final-answer\`, \`agent-message\`, and \`plan\`. Pages walk backward from the end, and oversized records are split at stable newline-preferred boundaries. When older evidence exists, the output provides the exact filtered \`--before <cursor>\` command for the previous non-overlapping page. Historical pages intentionally omit newer evidence; never infer the current objective or approval state from a historical page alone.

For targeted lookup across the complete visible narrative transcript:

\`wb thread recall search --thread ${threadId} --query "<text>" [--kind <kind>...] [--limit <count>] [--before <ref>]\`

Search results are newest-first pages with stable refs and an exact older-results command. Read the complete content of one result through fixed-budget pages with:

\`wb thread recall expand --thread ${threadId} --ref <ref> [--cursor <cursor>]\`

Recall includes user messages, steers, questionnaire responses, assistant commentary and final answers, phase-less assistant messages, and plans. When a selected assistant message already contains an embedded plan, the derived plan record is suppressed rather than emitted twice. Recall does not include reasoning, raw commands, tool output, Browse data, hooks, or compaction markers. \`wb thread context\` remains a temporary compatibility alias, but use \`wb thread recall\` going forward.

Run only one Thread Recall command at a time. History, search, and expansion cursors are relative to the exact page and filters that emitted them; do not launch recall calls in parallel or guess follow-up cursors. Read the current result, then run the exact continuation command it provides.

The returned Markdown is chronological source evidence, not a current-task specification. Treat the post-compaction summary as a compressed working hypothesis, then reconcile both sources with newer live user messages, the active workflow mode, explicit approvals, and the current workspace.

Before speaking or acting, privately form a concise current working set: the current objective, newest constraints, active mode, approval boundary, completed and remaining work, and relevant files. Classify recovered material as active, completed, superseded or rejected, historical background, or uncertain. Follow chronology and **Newest Instruction Wins**; do not revive old work merely because it appears in the recovered context. If relevance or approval is uncertain, inspect or ask instead of guessing.

The base history command is required after compaction; search and paginated expansion may also be used when targeted historical recall would help. These commands do not replace approval, relevant-file inspection, or checkpoint checks.
`.trim();
}

function buildWorkbenchGitInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return `
## Workbench Git Commits

When workflows or the user explicitly authorize a commit, use Workbench's bounded, thread-owned commit-selection workflow instead:

\`wb git add -- <path> [<path>...]\`

\`wb git unstage -- <path> [<path>...]\`

\`wb git commit --message <message>\`

When the control-plane project owns the thread but the files belong to another registered worktree of the same repository, keep the command cwd in the control-plane project and add \`--worktree <absolute-path>\` to each add, unstage, and commit command. The explicit worktree selects the Git execution root and the thread's per-worktree selection namespace; it does not reinterpret thread identity.

\`wb git add\` records the exact files that are currently changed beneath the requested paths. It does not snapshot their contents or modify the repository's ordinary Git index. Later edits to a selected file are included when \`wb git commit\` reads that file's current contents. \`wb git unstage\` removes exact selected files or selected descendants of a requested directory; use \`.\` to clear the thread's selection.

Each managed thread owns an isolated selection list for each Git worktree. \`wb git commit\` runs host-side \`git add\` for the selected files followed by a path-limited \`git commit --only\`, then clears the selection after success. Unrelated ordinary staged files remain staged and excluded. Failures retain the selection; because the add is real, a later commit failure may leave the selected files staged in the ordinary Git index.

## Workbench Git Checkpoints

Workbench supports hidden Git checkpoints for agent workflow baselines through the canonical \`wb git checkpoint\` command family. Checkpoints are real local Git commit objects stored under per-worktree refs, not visible branch commits.

This thread's checkpoint namespace is owned by Workbench and scoped to the current Git worktree:

\`\`\`text
refs/worktree/agents/${threadId}/checkpoints
\`\`\`

Checkpoint refs are convenience state, not a security boundary. Do not use them to store secrets unless the repo state is already allowed to contain those secrets.

Use these exact CLI shapes so Workbench can match and render checkpoint operations. Workbench owns the Git plumbing and uses a temporary index internally, so agents should not run raw \`git update-ref\` checkpoint scripts themselves.

### Create a baseline checkpoint

Run after entering Brief mode for an approved-plan baseline; call this returned checkpoint commit the approval checkpoint. Also run in Implement mode after the start-of-implementation checkpoint diff is classified safe and before the first file edit; call that returned checkpoint commit the initial implementation checkpoint for the current implementation arc.

\`wb git checkpoint baseline\`

### Diff against a specific checkpoint

Run immediately after entering Implement mode before editing by passing the approval checkpoint commit. Run again after entering Review mode before summarizing changes by passing the initial implementation checkpoint commit for the current implementation arc. Do not omit \`checkpointCommit\`, do not substitute the newest checkpoint, and do not guess from thread history; parallel agents may create unrelated newer checkpoints. The command output is a compact checkpoint diff summary for agent review. Workbench stores the full unified diff separately and renders it for the user in the UI.

\`wb git checkpoint diff --commit <checkpoint-commit-sha>\`

### Diff a specific file against a specific checkpoint

Use after the compact checkpoint diff when a changed file may dangerously intersect with the approved edit files, nearby ownership, contracts, dependencies, validation scope, branch/HEAD, or mechanics needed by the plan. Use the same \`checkpointCommit\` as the compact diff you are investigating. Replace \`<repo-relative-path>\` with a changed file path from that compact summary. The command returns that file's unified diff only.

\`wb git checkpoint file-diff --commit <checkpoint-commit-sha> --file <repo-relative-path>\`

### Create a diff checkpoint

Do not run this as part of normal Review mode. Use only when the user explicitly asks to preserve the current state as a checkpoint.

\`wb git checkpoint create-diff\`

### Restore selected paths after explicit user request

First run the checkpoint diff or another preview. Pass every file or directory to restore after \`--\`; Workbench restores only those paths from the specified checkpoint, removes selected paths that were created after it, and leaves the real Git index unchanged. The repository root is not a valid selected path. Workbench blocks when the checkpoint parent is not the current HEAD.

\`wb git checkpoint restore --commit <checkpoint-commit-sha> -- <path> [<path>...]\`

### Restore a full checkpoint after explicit user request

Use the path form instead when only part of the worktree must be restored. Full restore uses a checkpoint commit sha supplied by the user or selected from the thread's checkpoint output. The CLI requires \`--confirm\`, and Workbench blocks when the checkpoint parent is not the current HEAD.

\`wb git checkpoint restore --commit <checkpoint-commit-sha> --confirm\`
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
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadRecallInstructions(context),
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
    buildWorkbenchOrchestratorReloadInstructions(context),
    buildWorkbenchThreadRecallInstructions(context),
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
    buildWorkbenchThreadRecallInstructions(context),
    buildWorkbenchGitInstructions(context),
    buildWorkbenchSubagentInstructions(context),
    buildThreadTitleInstructions(context),
    buildThreadStatusInstructions(context),
  ]);
}

const WorkbenchPromptFiles = {
  buildWorkbenchCollaborationDeveloperInstructions,
  buildWorkbenchPromptInstructions,
  buildWorkbenchThreadUtilityDeveloperInstructions,
  ensureWorkbenchPromptFiles,
  listWorkbenchInstructionMechanics,
};

export default WorkbenchPromptFiles;
