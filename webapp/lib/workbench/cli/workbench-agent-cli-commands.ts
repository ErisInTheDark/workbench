/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliResponseKind/WorkbenchAgentCliParseResult: compatibility names for normalized CLI request and parse contracts. Keywords: workbench, cli, request, parse.
 * - WorkbenchAgentCliCommandDescriptor/listWorkbenchAgentCliCommandDescriptors: expose immutable canonical command metadata. Keywords: workbench, cli, metadata, tools.
 * - WORKBENCH_AGENT_CLI_HELP: complete agent-facing command reference. Keywords: workbench, cli, help, commands.
 * - parseWorkbenchAgentCliCommand: adapt allowlisted wb argv into the canonical typed command registry. Keywords: workbench, cli, allowlist, cwd.
 */
import path from "node:path";

import type { OrchestratorReloadScopeDescriptor } from "../orchestrator-reload";
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
  "1. In Brief mode, create one inactive clean plan: wb git arc plan -m <short-intent> [-m <optional-description>] -- <path> [<path>...]",
  "2. After approval, activate and inspect it without creating another ref: wb git arc start --ref <plan-ref>",
  "3. Wait for sibling claims blocking an inactive plan: wb git arc wait [--ref <plan-ref>]",
  "4. Active mutation commands resolve this thread's registered arc. Do not pass --ref to add, adopt, remove, or propose.",
  "5. Before a later pass on the same files, continue from the remembered ref: wb git arc continue --ref <current-ref>",
  "6. Continue while adding genuinely new clean paths: wb git arc add -- <additional-path> [<additional-path>...]",
  "7. Adopt existing dirty workspace paths: wb git arc adopt -- <dirty-path> [<dirty-path>...]",
  "8. Move paths and claim both sides: wb git arc mv <source>... <destination> / wb git arc mv --map <source> <destination> [...].",
  "9. Preview up to 200 regex moves, then repeat with --confirm: wb git arc mv --regex <pattern> --replace <replacement> -- <root> [...].",
  "10. Relinquish exact clean claims: wb git arc remove -- <claimed-path> [<claimed-path>...]",
  "11. Release every clean claim without changing files: wb git arc release. Use --disown only to release dirty ownership explicitly.",
  "12. Record successors returned by add, adopt, mv, remove, or continue for later continuation. Final clean removal releases the arc without an active successor.",
  "13. Summarize or inspect an arc or proposal: wb git arc compare [--ref <arc-sha|proposal-id>] [-- <path> [<path>...]] / wb git arc diff [--ref <arc-sha|proposal-id>] [--page <page>] [-- <path> [<path>...]]",
  "14. Propose a normal commit: wb git arc propose [--root <root-id>] --title <fresh-title> [--description <optional-description>] [-- <claimed-path> [<claimed-path>...]]",
  "15. Propose title and description changes to an exact accepted commit without an active arc: wb git arc propose --amend <proposal-id> --title <replacement-title> [--description <replacement-description>]",
  "16. Amend current unpushed HEAD content from the active arc: wb git arc propose --amend [--title <replacement-title>] [--description <replacement-description>] -- <claimed-path> [...]",
  "17. Use the same arc continue command after a proposal is committed and before follow-up work.",
  "18. Restore selected paths: wb git arc restore --ref <ref> -- <path> [<path>...]",
  "19. Restore the full arc only after explicit user direction: wb git arc restore --ref <ref> --confirm",
  "",
  "Plan and arc add paths must be clean against HEAD. Arc adopt is only for paths that already contain workspace changes.",
  "If Review finds more work while a proposal is pending, arc continue retires that stale proposal and continues the active arc. Use arc add only when that pass also claims new clean paths.",
  "Starting checks sibling claim collisions. Active claims prevent thread settlement until they are committed, cleanly unclaimed, or explicitly restored.",
  "A partial commit advances the baseline and keeps the full active set claimed. Use arc remove to release clean paths intentionally. Arc continue returns that successor instead of creating another baseline.",
  "If Workbench rejects a claim or continuation, stop and inspect the reported owner or drift. Do not clean or restore paths automatically.",
  "Omit explicit compare, diff, or proposal paths to use the arc's claimed set. Proposal subsets must stay inside that set.",
  "In a multi-root workspace, qualify CLI paths as <root-id>:<path>. Create one logical arc across roots and propose each root as a separate commit. Typed MCP callers should use roots and refs instead.",
  "",
].join("\n");

const COMMAND_DESCRIPTORS: readonly WorkbenchAgentCliCommandDescriptor[] = Object.freeze(
  listWorkbenchAgentCommands().filter((command) => !command.hideFromRootHelp).map(({ description, usage, words }) => Object.freeze({
    description,
    usage,
    words: Object.freeze([...words]),
  })),
);

export function listWorkbenchAgentCliCommandDescriptors(catalog: readonly OrchestratorReloadScopeDescriptor[] = []) {
  return catalog.length
    ? listWorkbenchAgentCommands(catalog, "cli").filter((command) => !command.hideFromRootHelp).map(({ description, usage, words }) => ({ description, usage, words }))
    : COMMAND_DESCRIPTORS;
}

const ROOT_HELP_COMMAND_ORDER = [
  "rg",
  "tokens", "tokens instructions",
  "subagent list", "subagent profiles", "subagent create", "subagent wait", "subagent stop", "subagent message",
  "thread title", "thread title get", "thread recall", "thread recall search", "thread recall expand",
  "git add", "git unstage", "git commit", "git arc plan", "git arc start", "git arc wait", "git arc continue", "git arc add",
  "git arc mv", "git arc remove", "git arc release", "git arc compare", "git arc diff", "git arc propose", "git arc restore",
  "browse run", "browse raw", "browse sessions", "browse stop", "browse forget",
] as const;

const HELP_GROUPS: readonly HelpGroupDefinition[] = [
  {
    commandOrder: ["tokens", "tokens instructions"],
    footer: "Pass one exact text value after --. Managed threads can count instructions only from the running Workbench repository root.",
    key: "tokens", usage: "wb tokens [instructions] [options]", words: ["tokens"],
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
    commandOrder: ["thread title", "thread title get", "thread recall", "thread recall search", "thread recall expand"],
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
    commandOrder: ["git arc plan", "git arc start", "git arc wait", "git arc continue", "git arc add", "git arc mv", "git arc remove", "git arc release", "git arc compare", "git arc diff", "git arc propose", "git arc restore"],
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
function renderRootHelp(commands = listWorkbenchAgentCommands()) {
  commands = commands.filter((command) => !command.hideFromRootHelp);
  commands = orderCommands(commands, ROOT_HELP_COMMAND_ORDER);
  const helpGroups = HELP_GROUPS.filter((group) => commands.some((command) => command.helpGroups.includes(group.key)));
  return [
    "Usage:", "  wb --help", "  wb <command> [options]", "", "Commands:",
    ...commands.map((command) => `  ${command.usage}`), "", "Help commands:",
    ...helpGroups.map((group) => `  wb ${group.words.join(" ")} --help`), "",
    "Project ownership is derived from the current working directory.", "",
  ].join("\n");
}
function renderReloadOptions(catalog: readonly OrchestratorReloadScopeDescriptor[], includeUnsafe: boolean) {
  const regular = catalog.filter((entry) => !entry.destructive && entry.scope !== "server:process");
  const destructive = catalog.filter((entry) => entry.destructive && entry.scope !== "server:process");
  return [
    "Options:",
    "  --all                         Reload every dirty non-destructive scope.",
    "  --all --unsafe                Include dirty destructive scopes.",
    "  --hard                        Restart the complete orchestrator process.",
    ...regular.map((entry) => `  --${entry.scope.padEnd(28)} ${entry.description}`),
    ...(destructive.length ? ["", "Destructive scopes:", ...destructive.map((entry) => `  --${entry.scope.padEnd(28)} ${entry.description}`)] : []),
  ].join("\n");
}
function renderGroupHelp(
  group: HelpGroupDefinition,
  includeUnsafe = false,
  allCommands = listWorkbenchAgentCommands(),
  reloadCatalog: readonly OrchestratorReloadScopeDescriptor[] = [],
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
    reloadCatalog?: readonly OrchestratorReloadScopeDescriptor[];
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
  const isLegacyCheckpointCommand = (argv[0] === "git" && argv[1] === "checkpoint") || argv[0] === "checkpoint" || (argv[0] === "git" && argv[1] === "plan");
  if (isLegacyCheckpointCommand) return { help: LEGACY_CHECKPOINT_MIGRATION_GUIDE, kind: "help" };
  const workbenchArgs = argsBeforeTrailingSeparator(argv);
  if (!argv.length || workbenchArgs.includes("--help") || argv[0] === "help") {
    const group = matchHelpGroup(helpPath(workbenchArgs));
    return { help: group ? renderGroupHelp(group, argv.includes("--unsafe"), commands, reloadCatalog) : renderRootHelp(commands), kind: "help" };
  }
  const matched = commands.flatMap((definition) => (
    [definition.words, ...(definition.aliases ?? [])].map((words) => ({ definition, words }))
  )).filter((candidate) => matchesWords(argv, candidate.words)).sort((left, right) => right.words.length - left.words.length)[0];
  if (!matched) return { error: `Unsupported wb command: ${argv.join(" ")}\n\n${renderRootHelp(commands)}`, kind: "error" };
  try {
    return {
      kind: "request",
      request: await matched.definition.buildRequestFromCli(argv.slice(matched.words.length), { callerHarness, callerThreadId, cwd, workbenchOrigin }),
    };
  } catch (error) {
    return { error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`, kind: "error" };
  }
}
