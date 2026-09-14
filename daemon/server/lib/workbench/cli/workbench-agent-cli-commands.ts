/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliResponseKind/WorkbenchAgentCliParseResult: normalised CLI contracts.
 * - WorkbenchAgentCliCommandDescriptor/listWorkbenchAgentCliCommandDescriptors: canonical command metadata.
 * - WORKBENCH_AGENT_CLI_HELP: agent-facing command reference.
 * - parseWorkbenchAgentCliCommand: adapt CLI arguments into the typed command registry.
 */
import path from "node:path";
import { createGitArcFailureFromError, formatGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { WorkbenchCommandArgumentError } from "../commands/workbench-agent-command-arguments";

import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry";
import type {
  WorkbenchAgentCommandDefinition,
  WorkbenchAgentCommandRequest,
  WorkbenchAgentCommandResponseKind,
} from "../commands/workbench-agent-command-definition";

export type WorkbenchAgentCliRequest = WorkbenchAgentCommandRequest;
export type WorkbenchAgentCliResponseKind = WorkbenchAgentCommandResponseKind;

export type WorkbenchAgentCliParseResult =
  | { help: string; kind: "help" }
  | { error: string; kind: "error" }
  | { kind: "request"; request: WorkbenchAgentCommandRequest };

export interface WorkbenchAgentCliCommandDescriptor {
  readonly description: string;
  readonly usage: string;
  readonly words: readonly string[];
}

interface HelpGroupDefinition {
  aliases?: readonly (readonly string[])[];
  commandOrder?: readonly string[];
  footer?: string;
  key: string;
  options?: string;
  unsafeOptions?: string;
  usage: string;
  words: readonly string[];
}

const LEGACY_CHECKPOINT_MIGRATION_GUIDE = [
  "wb git checkpoint commands have been replaced by the named plan and arc workflow.",
  "",
  "Use these commands:",
  "Plan: wb git plan claims -m <intent> -- <path>...",
  "Revise scope: wb git plan claims --inherit -- <add-path> -<remove-path> '*<adopt-path>'",
  "Activate approved scope: wb git arc start. Wait for sibling collisions: wb git arc wait.",
  "Edit active scope: wb git arc claims --inherit -- <add-path> -<remove-path> '*<adopt-path>'. Continuation checks are included.",
  "Follow-ups: wb git arc status before rereading. Resume unchanged scope: wb git arc continue.",
  "Inspect: wb git arc compare / wb git arc diff. Explicit paths return a complete unpaged diff.",
  "Propose: wb git arc propose --title <title>. Replace pending proposals with --replace <id>.",
  "Content amend: wb git arc propose --amend [<proposal-id>] --fresh-title <title>.",
  "Message-only proposal: wb git arc reword --proposal <id> --title <title>.",
  "Move approved paths: wb git arc mv. Release clean claims: wb git arc release.",
  "Restore selected paths: wb git arc restore --ref <ref> -- <path>...",
  "Full restore requires explicit user direction and --confirm. Dirty release requires explicit --disown.",
  "",
  "Planning refreshes baselines and reports drift against the previous plan. Inspect that drift before briefing.",
  "Adoption is only for intentional dirty unclaimed work. Never overwrite sibling work to clear a collision.",
  "Resolved continuation acquires nothing. Approved follow-up needs explicit new scope.",
  "Ordinary operations use the caller's lifecycle. Explicit refs select historical inspection or restoration.",
  "Qualify multi-root CLI paths as <root-id>:<path>; MCP uses root-qualified arrays. Propose each root separately.",
  "",
].join("\n");

const COMMAND_DESCRIPTORS: readonly WorkbenchAgentCliCommandDescriptor[] = Object.freeze(
  listWorkbenchAgentCommands().filter((command) => !command.hideFromRootHelp).map(({ description, usage, words }) => Object.freeze({
    description,
    usage,
    words: Object.freeze([...words]),
  })),
);

export function listWorkbenchAgentCliCommandDescriptors(catalog: readonly DaemonReloadScopeDescriptor[] = []) {
  return catalog.length
    ? listWorkbenchAgentCommands(catalog, "cli").filter((command) => !command.hideFromRootHelp).map(({ description, usage, words }) => ({ description, usage, words }))
    : COMMAND_DESCRIPTORS;
}

const ROOT_HELP_COMMAND_ORDER = [
  "toc", "rg",
  "tokens", "tokens instructions", "tokens project",
  "transcript projects", "transcript threads", "transcript turns", "transcript search", "transcript read", "transcript show", "transcript stats",
  "stats claims",
  "subagent list", "subagent profiles", "subagent create", "subagent wait", "subagent stop", "subagent message",
  "task set", "task get", "task completed", "task blocked",
  "thread recall", "thread recall search", "thread recall expand",
  "git add", "git unstage", "git commit", "git plan claims", "git plan start", "git arc start", "git arc wait", "git arc continue", "git arc claims",
  "git arc status", "git arc scope", "git arc mv", "git arc release", "git arc compare", "git arc diff", "git arc propose", "git arc reword", "git arc restore",
  "browse run", "browse raw", "browse sessions", "browse stop", "browse forget",
] as const;

const HELP_GROUPS: readonly HelpGroupDefinition[] = [
  {
    key: "transcript", usage: "wb transcript <projects|threads|turns|search|read|show|stats> [options]", words: ["transcript"],
    commandOrder: ["transcript projects", "transcript threads", "transcript turns", "transcript search", "transcript read", "transcript show", "transcript stats"],
    footer: [
      "Start with a Workbench thread id: wb transcript search --thread <wb-id> --query <text>",
      "Read directly: wb transcript read --thread <wb-id>. Inspect turns: wb transcript turns --thread <wb-id>.",
      "Context: wb transcript read --thread <wb-id> --around <item-id> --context 5.",
      "Read/search show canonical item data with trimmed text. Expand: wb transcript show --thread <wb-id> --item <item-id>.",
      "Show preserves full values across continuation pages. Text output omits empty preview fields; matching cwd displays as '.'.",
      "SQLite only: no provider materialisation, native transcript files, imports or writes. Coverage describes stored thread bodies.",
      "All projects, archived and settled threads are included by default. --thread uses exact Workbench ids, not provider ids.",
      "Common: --project <id> --harness <provider-key> --archived <true|false> --settled <true|false>.",
      "Time: --since/--until <UTC-date|ISO-with-timezone|epoch-ms>, inclusive. Thread lists use activity time; items use creation time.",
      "Search/read/stats: --turn <id> --kind <kind>... --phase <commentary|finalAnswer|unknown> --tool <exact-name> --file <path-substring>.",
      "Kinds: user-message, user-steer, assistant-message, plan, reasoning, process, tool, collaboration, tool-output, file-change, web-search, questionnaire, approval, compaction, unknown.",
      "Search/thread-title matching: --query <literal>... (all terms per item), --any (any term), --exclude <literal>..., --case-sensitive.",
      "Search/read/show: --opaque includes canonical opaque fields, never binary assets or provider-native evidence.",
      "Read/turns/search: --direction <older|newer>. Read pages render chronologically; older starts at the end, newer at the start.",
      "Pages: --limit <1-50>, --cursor <returned-cursor>, --json. Search scans bounded worker batches until a page fills or history ends.",
      "Cursors exclude new insertions, not edits to live items. Changed expansion content invalidates its cursor.",
      "Managed agents must run at the Workbench repository root. Ordinary user CLI access is allowed. No MCP tools.",
    ].join("\n"),
  },
  {
    commandOrder: ["stats claims"],
    key: "stats", usage: "wb stats claims [options]", words: ["stats"],
    footer: [
      "Default range: 7d. Pages contain at most 50 rows; increment --page to continue.",
      "Ownership comes from cwd. Unqualified files use its owning root; root:path selects a workspace root.",
      "Counts mean distinct claiming threads, not claim duration or checkpoint count.",
      "Reads imported SQLite history only; unsupported or unavailable history cannot contribute.",
      "Use wb thread recall --thread <id> to inspect a returned managed thread.",
    ].join("\n"),
  },
  {
    commandOrder: ["toc"],
    key: "toc", usage: "wb toc <file>", words: ["toc"],
  },
  {
    commandOrder: ["tokens", "tokens instructions", "tokens project"],
    footer: "Pass one exact text value after --. Project counting uses the command cwd. Managed threads can count Workbench source instructions only from the running Workbench repository root.",
    key: "tokens", usage: "wb tokens [instructions|project] [options]", words: ["tokens"],
  },
  {
    commandOrder: ["rg"],
    footer: [
      "Pass each native ripgrep argument after --.",
      "No matches return successful empty output.",
      "Process-launching --pre and --hostname-bin arguments are unavailable.",
    ].join("\n"),
    key: "rg", usage: "wb rg -- <rg args>", words: ["rg"],
  },
  {
    commandOrder: ["subagent list", "subagent profiles", "subagent create", "subagent wait", "subagent message", "subagent stop"],
    footer: ["The current managed thread is always the parent.", "Run commands from the intended project working directory."].join("\n"),
    key: "subagent", usage: "wb subagent <command> [options]", words: ["subagent"],
  },
  {
    commandOrder: ["task set", "task get", "task completed", "task blocked"],
    key: "task", usage: "wb task <command> [options]", words: ["task"],
  },
  {
    commandOrder: ["thread recall", "thread recall search", "thread recall expand"],
    key: "thread", usage: "wb thread <command> [options]", words: ["thread"],
  },
  {
    aliases: [["thread", "context"]],
    commandOrder: ["thread recall", "thread recall search", "thread recall expand"],
    footer: [
      "Kinds: user-message, user-steer, questionnaire, commentary, final-answer, agent-message, plan.",
      "Recall excludes reasoning, raw commands, tool output, Browse data, hooks, and compaction markers.",
      "Run one recall command at a time and follow the exact continuation command emitted by the current page.",
    ].join("\n"),
    key: "thread-recall", usage: "wb thread recall [command] [options]", words: ["thread", "recall"],
  },
  {
    commandOrder: ["git add", "git unstage", "git commit"],
    footer: [
      "Run from the repository root and use . with add to select all changed files.",
      "Run from the repository root and use . with unstage to clear the thread selection.",
      "Use --worktree with an absolute registered worktree path while keeping the command cwd as the control-plane project.",
      "Git commands derive the current managed thread ID from Workbench caller context.",
      "Unrelated files in the ordinary Git index remain outside the thread-owned commit.",
    ].join("\n"),
    key: "git", usage: "wb git <command> [options]", words: ["git"],
  },
  {
    aliases: [["git", "plan"]],
    commandOrder: ["git plan claims", "git plan start", "git arc start", "git arc wait", "git arc continue", "git arc claims", "git arc status", "git arc scope", "git arc mv", "git arc release", "git arc compare", "git arc diff", "git arc propose", "git arc reword", "git arc restore"],
    footer: [
      "Pass paths after -- to restore only those files or directories from the arc snapshot.",
      "Use --confirm without paths only when the user explicitly requested a full arc restore.",
    ].join("\n"),
    key: "git-arc", usage: "wb git arc <command> [options]", words: ["git", "arc"],
  },
  {
    commandOrder: ["browse run", "browse sessions", "browse stop", "browse forget", "browse raw"],
    footer: [
      "Use the /browse skill for browser workflow, sequencing, screenshots, and cleanup.",
      "Raw passthrough is unavailable unless Workbench explicitly enables it.",
      "Each wb browse call must contain only one BrowseMD run, raw invocation, or session command.",
    ].join("\n"),
    key: "browse", usage: "wb browse <command> [options]", words: ["browse"],
  },
  {
    key: "reload",
    footer: [
      "Group any same-namespace scopes with +.",
      "Example: wb reload --server:core+browse+mcp",
      "reloading is the responsibility of the user. if you intend to do a reload, you should be operating with the user's permission.",
    ].join("\n"),
    usage: "wb reload [--all [--unsafe] | --<scope> ... | --hard]",
    words: ["reload"],
  },
];

function commandKey(command: WorkbenchAgentCommandDefinition) { return command.words.join(" "); }
function orderCommands(commands: readonly WorkbenchAgentCommandDefinition[], order: readonly string[]) {
  const indexes = new Map(order.map((key, index) => [key, index]));
  return [...commands].sort((left, right) => (indexes.get(commandKey(left)) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(commandKey(right)) ?? Number.MAX_SAFE_INTEGER));
}
function renderRootHelp(commands = listWorkbenchAgentCommands(), isWorkbenchRoot = false) {
  commands = commands.filter((command) => !command.hideFromRootHelp);
  commands = orderCommands(commands, ROOT_HELP_COMMAND_ORDER);
  const helpGroups = HELP_GROUPS.filter((group) => commands.some((command) => command.helpGroups.includes(group.key)));
  return [
    "Usage:", "  wb --help", "  wb <command> [options]", "", "Commands:",
    ...commands.map((command) => `  ${command.usage}`),
    ...(isWorkbenchRoot ? ["  wb test [--list] [-- [<file>...]]  (local, claims-selected or explicit tests)"] : []), "", "Help commands:",
    ...helpGroups.map((group) => `  wb ${group.words.join(" ")} --help`), "",
    "Project ownership is derived from the current working directory.", "",
  ].join("\n");
}
function renderReloadOptions(catalog: readonly DaemonReloadScopeDescriptor[], includeUnsafe: boolean) {
  const regular = catalog.filter((entry) => !entry.destructive && entry.scope !== "server:process");
  const destructive = catalog.filter((entry) => entry.destructive && entry.scope !== "server:process");
  return [
    "Options:",
    "  --all                         Reload every dirty non-destructive scope.",
    "  --all --unsafe                Include dirty destructive scopes.",
    "  --hard                        Restart the complete daemon process.",
    ...regular.map((entry) => `  --${entry.scope.padEnd(28)} ${entry.description}`),
    ...(destructive.length ? ["", "Destructive scopes:", ...destructive.map((entry) => `  --${entry.scope.padEnd(28)} ${entry.description}`)] : []),
  ].join("\n");
}
function renderGroupHelp(
  group: HelpGroupDefinition,
  includeUnsafe = false,
  allCommands = listWorkbenchAgentCommands(),
  reloadCatalog: readonly DaemonReloadScopeDescriptor[] = [],
) {
  const commands = orderCommands(allCommands.filter((command) => command.helpGroups.includes(group.key)), group.commandOrder ?? []);
  const commandSection = group.key === "reload" ? renderReloadOptions(reloadCatalog, includeUnsafe) : group.options ?? [
    "Commands:",
    ...commands.flatMap((command, index) => [...(index ? [""] : []), `  ${command.usage}`, `    ${command.description}`]),
  ].join("\n");
  return [
    "Usage:", `  ${group.usage}`, "", commandSection,
    ...(includeUnsafe && group.unsafeOptions ? ["", group.unsafeOptions] : []),
    ...(group.footer ? ["", group.footer] : []), "",
  ].join("\n");
}
function matchesWords(argv: readonly string[], words: readonly string[]) { return words.every((word, index) => argv[index] === word); }
function matchHelpGroup(argv: readonly string[]) {
  return HELP_GROUPS.flatMap((group) => [group.words, ...(group.aliases ?? [])].map((words) => ({ group, words })))
    .filter((candidate) => matchesWords(argv, candidate.words))
    .sort((left, right) => right.words.length - left.words.length)[0]?.group ?? null;
}
function helpPath(argv: readonly string[]) { return argv[0] === "help" ? [] : argv.filter((argument) => argument !== "--help"); }
function argsBeforeTrailingSeparator(argv: readonly string[]) {
  const separatorIndex = argv.indexOf("--");
  return separatorIndex < 0 ? [...argv] : argv.slice(0, separatorIndex);
}

export const WORKBENCH_AGENT_CLI_HELP = renderRootHelp();

export async function parseWorkbenchAgentCliCommand(
  argv: string[],
  {
    cwd = process.cwd(),
    callerHarness = process.env.WORKBENCH_HARNESS?.trim() || "codex",
    callerThreadId = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || null,
    workbenchOrigin = process.env.WORKBENCH_ORIGIN?.trim() || null,
    reloadCatalog = [],
    projectRoot = null,
  }: {
    callerHarness?: string;
    callerThreadId?: string | null;
    cwd?: string;
    workbenchOrigin?: string | null;
    reloadCatalog?: readonly DaemonReloadScopeDescriptor[];
    projectRoot?: string | null;
  } = {},
): Promise<WorkbenchAgentCliParseResult> {
  const resolvedCwd = path.resolve(cwd);
  const isWorkbenchRoot = projectRoot !== null && (
    process.platform === "win32"
      ? resolvedCwd.toLocaleLowerCase() === path.resolve(projectRoot).toLocaleLowerCase()
      : resolvedCwd === path.resolve(projectRoot)
  );
  const commands = listWorkbenchAgentCommands(reloadCatalog, "cli").filter((command) => (
    !command.managedThreadRootOnly || callerThreadId === null || isWorkbenchRoot
  ));
  const isLegacyCheckpointCommand = (argv[0] === "git" && argv[1] === "checkpoint") || argv[0] === "checkpoint";
  if (isLegacyCheckpointCommand) return { help: LEGACY_CHECKPOINT_MIGRATION_GUIDE, kind: "help" };
  const workbenchArgs = argsBeforeTrailingSeparator(argv);
  if (!argv.length || workbenchArgs.includes("--help") || argv[0] === "help") {
    const group = matchHelpGroup(helpPath(workbenchArgs));
    return { help: group ? renderGroupHelp(group, argv.includes("--unsafe"), commands, reloadCatalog) : renderRootHelp(commands, isWorkbenchRoot), kind: "help" };
  }
  const matched = commands.flatMap((definition) => (
    [definition.words, ...(definition.aliases ?? [])].map((words) => ({ definition, words }))
  )).filter((candidate) => matchesWords(argv, candidate.words)).sort((left, right) => right.words.length - left.words.length)[0];
  if (!matched) {
    const group = matchHelpGroup(workbenchArgs);
    const help = group ? `wb ${group.words.join(" ")} --help` : "wb --help";
    if (argv[0] === "git" && (argv[1] === "arc" || argv[1] === "plan")) {
      const failure = createGitArcFailureFromError("unknown", new GitArcRejectionError(
        { reason: "unsupportedCommand" }, `Unsupported wb command: ${workbenchArgs.join(" ")}\nRun ${help} for available commands.`,
      ));
      return { error: formatGitArcFailureReceipt(failure), kind: "error" };
    }
    return { error: `Unsupported wb command: ${workbenchArgs.join(" ")}\nRun ${help} for available commands.`, kind: "error" };
  }
  try {
    return {
      kind: "request",
      request: await matched.definition.buildRequestFromCli(argv.slice(matched.words.length), { callerHarness, callerThreadId, cwd, workbenchOrigin }),
    };
  } catch (error) {
    if (matched.words[0] === "git" && (matched.words[1] === "arc" || matched.words[1] === "plan")) {
      const cause = error instanceof WorkbenchCommandArgumentError
        ? new GitArcRejectionError(error.kind === "unexpectedTrailingArguments"
          ? { reason: error.kind }
          : { reason: error.kind, argument: error.argument }, error.message)
        : error;
      return { error: `${formatGitArcFailureReceipt(createGitArcFailureFromError("unknown", cause))}\n\nUsage: ${matched.definition.usage}`, kind: "error" };
    }
    return { error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`, kind: "error" };
  }
}
