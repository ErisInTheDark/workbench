/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliResponseKind/WorkbenchAgentCliParseResult: compatibility names for normalized CLI request and parse contracts. Keywords: workbench, cli, request, parse.
 * - WorkbenchAgentCliCommandDescriptor/listWorkbenchAgentCliCommandDescriptors: expose immutable canonical command metadata. Keywords: workbench, cli, metadata, tools.
 * - WORKBENCH_AGENT_CLI_HELP: complete agent-facing command reference. Keywords: workbench, cli, help, commands.
 * - parseWorkbenchAgentCliCommand: adapt allowlisted wb argv into the canonical typed command registry. Keywords: workbench, cli, allowlist, cwd.
 */
import { WORKBENCH_AGENT_COMMANDS } from "../commands/workbench-agent-command-registry";
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
  usage: string;
  words: readonly string[];
}

const LEGACY_CHECKPOINT_MIGRATION_GUIDE = [
  "wb git checkpoint commands have been replaced by the named plan and arc workflow.",
  "",
  "Use these commands:",
  "1. In Brief mode, create one inactive clean plan: wb git arc plan -m <short-intent> [-m <optional-description>] -- <path> [<path>...]",
  "2. After approval, activate and inspect it without creating another ref: wb git arc start --ref <plan-ref>",
  "3. Active commands resolve this thread's registered arc. Do not pass --ref to add, adopt, remove, compare, diff, or propose.",
  "4. Before a later pass on the same files, continue from the remembered ref: wb git arc continue --ref <current-ref>",
  "5. Continue while adding genuinely new clean paths: wb git arc add -- <additional-path> [<additional-path>...]",
  "6. Adopt existing dirty workspace paths: wb git arc adopt -- <dirty-path> [<dirty-path>...]",
  "7. Move paths and claim both sides: wb git arc mv <source>... <destination> / wb git arc mv --map <source> <destination> [...].",
  "8. Preview up to 200 regex moves, then repeat with --confirm: wb git arc mv --regex <pattern> --replace <replacement> -- <root> [...].",
  "9. Relinquish exact clean claims: wb git arc remove -- <claimed-path> [<claimed-path>...]",
  "10. Record successors returned by add, adopt, mv, remove, or continue for later continuation. Final clean removal releases the arc without an active successor.",
  "11. Summarize or inspect the active arc: wb git arc compare [-- <path> [<path>...]] / wb git arc diff [-- <path> [<path>...]]",
  "12. Propose a normal commit: wb git arc propose -m <fresh-title> [-m <optional-description>] [-- <claimed-path> [<claimed-path>...]]",
  "13. Amend exact current unpushed HEAD: wb git arc propose --amend [-m <replacement-title> [-m <replacement-description>]]",
  "14. Use the same arc continue command after a proposal is committed and before follow-up work.",
  "15. Restore selected paths: wb git arc restore --ref <ref> -- <path> [<path>...]",
  "16. Restore the full arc only after explicit user direction: wb git arc restore --ref <ref> --confirm",
  "",
  "Plan and arc add paths must be clean against HEAD. Arc adopt is only for paths that already contain workspace changes.",
  "If Review finds more work while a proposal is pending, arc continue retires that stale proposal and continues the active arc. Use arc add only when that pass also claims new clean paths.",
  "Starting checks sibling claim collisions. Active claims prevent thread settlement until they are committed, cleanly unclaimed, or explicitly restored.",
  "A partial commit advances the baseline and keeps the full active set claimed. Use arc remove to release clean paths intentionally. Arc continue returns that successor instead of creating another baseline.",
  "If Workbench rejects a claim or continuation, stop and inspect the reported owner or drift. Do not clean or restore paths automatically.",
  "Omit explicit compare, diff, or proposal paths to use the arc's claimed set. Proposal subsets must stay inside that set.",
  "",
].join("\n");

const COMMAND_DESCRIPTORS: readonly WorkbenchAgentCliCommandDescriptor[] = Object.freeze(
  WORKBENCH_AGENT_COMMANDS.map(({ description, usage, words }) => Object.freeze({
    description,
    usage,
    words: Object.freeze([...words]),
  })),
);

export function listWorkbenchAgentCliCommandDescriptors() {
  return COMMAND_DESCRIPTORS;
}

const ROOT_HELP_COMMAND_ORDER = [
  "subagent list", "subagent profiles", "subagent create", "subagent wait", "subagent stop", "subagent message",
  "thread title", "thread title get", "thread recall", "thread recall search", "thread recall expand",
  "git add", "git unstage", "git commit", "git arc plan", "git arc start", "git arc continue", "git arc add",
  "git arc mv", "git arc remove", "git arc compare", "git arc diff", "git arc propose", "git arc restore",
  "browse run", "browse raw", "browse sessions", "browse stop", "browse forget", "orchestrator reload",
] as const;

const HELP_GROUPS: readonly HelpGroupDefinition[] = [
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
    commandOrder: ["git arc plan", "git arc start", "git arc continue", "git arc add", "git arc mv", "git arc remove", "git arc compare", "git arc diff", "git arc propose", "git arc restore"],
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
    key: "orchestrator",
    options: [
      "Options:",
      "  --all                 Reload all non-destructive orchestrator scopes: orchestrator-logic, browse-controller, codex-bridge, mcp, opencode-bridge, next-dev.",
      "  --orchestrator-logic  Reload declared orchestrator modules.",
      "  --browse-controller   Drain and replace Browse controller code without restarting browser sessions.",
      "  --codex-bridge        Reload Codex bridge code without restarting the stable Codex app-server.",
      "  --mcp                 Reload the wb MCP implementation and advance its freshness generation.",
      "  --opencode-bridge     Reload OpenCode bridge code.",
      "  --opencode-server     Restart the managed OpenCode server.",
      "  --next-dev            Restart the Next.js development server.",
    ].join("\n"),
    footer: ["At least one option is required.", "Use the narrowest applicable scope."].join("\n"),
    usage: "wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--mcp] [--opencode-bridge] [--opencode-server] [--next-dev]",
    words: ["orchestrator"],
  },
];

function commandKey(command: WorkbenchAgentCommandDefinition) { return command.words.join(" "); }
function orderCommands(commands: readonly WorkbenchAgentCommandDefinition[], order: readonly string[]) {
  const indexes = new Map(order.map((key, index) => [key, index]));
  return [...commands].sort((left, right) => (indexes.get(commandKey(left)) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(commandKey(right)) ?? Number.MAX_SAFE_INTEGER));
}
function renderRootHelp() {
  const commands = orderCommands(WORKBENCH_AGENT_COMMANDS, ROOT_HELP_COMMAND_ORDER);
  const helpGroups = HELP_GROUPS.filter((group) => WORKBENCH_AGENT_COMMANDS.some((command) => command.helpGroups.includes(group.key)));
  return [
    "Usage:", "  wb --help", "  wb <command> [options]", "", "Commands:",
    ...commands.map((command) => `  ${command.usage}`), "", "Help commands:",
    ...helpGroups.map((group) => `  wb ${group.words.join(" ")} --help`), "",
    "Project ownership is derived from the current working directory.", "",
  ].join("\n");
}
function renderGroupHelp(group: HelpGroupDefinition) {
  const commands = orderCommands(WORKBENCH_AGENT_COMMANDS.filter((command) => command.helpGroups.includes(group.key)), group.commandOrder ?? []);
  const commandSection = group.options ?? [
    "Commands:",
    ...commands.flatMap((command, index) => [...(index ? [""] : []), `  ${command.usage}`, `    ${command.description}`]),
  ].join("\n");
  return ["Usage:", `  ${group.usage}`, "", commandSection, ...(group.footer ? ["", group.footer] : []), ""].join("\n");
}
function matchesWords(argv: readonly string[], words: readonly string[]) { return words.every((word, index) => argv[index] === word); }
function matchHelpGroup(argv: readonly string[]) {
  return HELP_GROUPS.flatMap((group) => [group.words, ...(group.aliases ?? [])].map((words) => ({ group, words })))
    .filter((candidate) => matchesWords(argv, candidate.words))
    .sort((left, right) => right.words.length - left.words.length)[0]?.group ?? null;
}
function helpPath(argv: readonly string[]) { return argv[0] === "help" ? [] : argv.filter((argument) => argument !== "--help"); }

export const WORKBENCH_AGENT_CLI_HELP = renderRootHelp();

export async function parseWorkbenchAgentCliCommand(
  argv: string[],
  {
    cwd = process.cwd(),
    callerHarness = process.env.WORKBENCH_HARNESS?.trim() || "codex",
    callerThreadId = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || null,
    workbenchOrigin = process.env.WORKBENCH_ORIGIN?.trim() || null,
  }: {
    callerHarness?: string;
    callerThreadId?: string | null;
    cwd?: string;
    workbenchOrigin?: string | null;
  } = {},
): Promise<WorkbenchAgentCliParseResult> {
  const isLegacyCheckpointCommand = (argv[0] === "git" && argv[1] === "checkpoint") || argv[0] === "checkpoint" || (argv[0] === "git" && argv[1] === "plan");
  if (isLegacyCheckpointCommand) return { help: LEGACY_CHECKPOINT_MIGRATION_GUIDE, kind: "help" };
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    const group = matchHelpGroup(helpPath(argv));
    return { help: group ? renderGroupHelp(group) : renderRootHelp(), kind: "help" };
  }
  const matched = WORKBENCH_AGENT_COMMANDS.flatMap((definition) => (
    [definition.words, ...(definition.aliases ?? [])].map((words) => ({ definition, words }))
  )).filter((candidate) => matchesWords(argv, candidate.words)).sort((left, right) => right.words.length - left.words.length)[0];
  if (!matched) return { error: `Unsupported wb command: ${argv.join(" ")}\n\n${WORKBENCH_AGENT_CLI_HELP}`, kind: "error" };
  try {
    return {
      kind: "request",
      request: await matched.definition.buildRequestFromCli(argv.slice(matched.words.length), { callerHarness, callerThreadId, cwd, workbenchOrigin }),
    };
  } catch (error) {
    return { error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`, kind: "error" };
  }
}
