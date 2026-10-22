/*
 * Exports:
 * - getNativeToolDisplay: select the provider-owned summary for a native tool call by its namespace.
 * - getNativeFileChanges/isNativeFileOperation/getNativeFileOperationOutcome/NativeFileChange/NativeFileOperationItem: classify provider-native and wb tool file calls, their lifecycle, and evidence.
 * - CommandMatcher: builder namespace for command-summary matchers, results, and summary parts.
 * - ThreadCommandSummaryDisplay: shared summary-display shape for single-command and grouped command labels.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills.
 * - ThreadCommandDetailRow/ThreadCommandDetailTarget: structured detail rows rendered inside command disclosures.
 * - ThreadCommandSummaryStats: what a command did, counted for activity chips and step icons.
 * - ThreadCommandDisplay: parsed command-summary metadata for thread command rendering.
 * - formatThreadCommandPath: resolve command paths into project-relative forward-slash display text.
 * - isBrowseCommandMatcherClaim/parseBrowseSequenceCommandOutput: detect and parse wb Browse command output.
 * - getGitArcMatcherAction/isGitCheckpointCompareMatcherClaim/isGitCheckpointDiffMatcherClaim/isGitCheckpointCommitMatcherClaim/isGitArcWaitMatcherClaim/parseGitArcWaitRef: detect arc matcher ids for specialised rendering.
 * - isThreadContextMatcherClaim/parseWorkbenchThreadRecallCommand/getWorkbenchThreadRecallSummaryDisplay: parse and present dedicated thread recall commands.
 * - parseWorkbenchFeedbackId: read the stored report id from a wb feedback acknowledgement.
 * - parseWorkbenchVisCommand/WorkbenchVisOperation: parse a `wb vis` call for its vis item.
 * - parseWorkbenchTodoCommand/WorkbenchTodoOperation: parse a `wb todo` call for its todo row.
 * - parseWorkbenchFeedbackCommand/parseWorkbenchMessageCommand/parseWorkbenchSubagentCommand/parseWorkbenchTaskTitleCommand/isWorkbenchTaskTitleSetMatcherClaim: parse semantic wb feedback/message/subagent/task-title actions and identify standalone title sets.
 * - parseWorkbenchTaskStatusCommand/isWorkbenchTaskStatusMatcherClaim: parse semantic completed/blocked task actions and identify dedicated status displays.
 * - parseGitArcCommand/parseGitArcReceipt/parseGitCheckpointCommitCommand/parseGitCheckpointCompareOutput/parseGitCheckpointProposalId: parse arc commands, receipts, comparison, and proposal output.
 * - parseGitCheckpointDiffArtifactId: parse compact checkpoint diff output for a stored full-diff artifact id.
 * - parseGitCheckpointDiffOutput: parse checkpoint diff command output into file-change display entries.
 * - getThreadCommandDisplay: reuse immutable command contexts, unwrap shell launchers, and describe common command patterns.
 * - getThreadCommandExecutionOutcome/getThreadCommandOutcomeDisplay: classify command lifecycle results and select completed or ongoing structured grammar.
 * - getThreadMcpToolCallOutcome/getThreadSubagentWaitMcpOutcome/isThreadMcpWaitInterruptedBySteer: classify wb MCP call lifecycles, counting a wait ended by an incoming message as completed.
 * - getWorkbenchMcpCommandDisplay/getWorkbenchMcpCommandRoute/getWorkbenchCommandRouteSummaryDisplay: map recorded wb MCP calls and resolved routes into summary or dedicated renderer operations.
 * - ThreadCommandExecutionOutcome: semantic completed, ongoing, timeout, failure, or decline state for command summaries.
 */

export {
  getNativeFileChanges, getNativeFileOperationOutcome, isNativeFileOperation,
  type NativeFileChange, type NativeFileOperationItem,
} from "./command-matchers/native-file-changes";

import type { CommandAction, CommandExecutionStatus, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import { getClaudeToolDisplay } from "./command-matchers/claude";
import { getOpenCodeToolDisplay } from "./command-matchers/opencode";
import {
    BROWSE_COMMAND_MATCHERS,
    isBrowseCommandMatcherClaim,
    parseBrowseSequenceCommandOutput,
} from "./command-matchers/browse";
import { CMD_COMMAND_MATCHERS } from "./command-matchers/cmd";
import { CommandMatcher, runThreadCommandMatchers } from "./command-matchers/core";
import {
    getGitArcMatcherAction,
    GIT_CHECKPOINT_COMMAND_MATCHERS,
    type GitArcCommandAction,
    type GitArcCommandIntent,
    type GitCheckpointCommitCommandIntent,
    isGitCheckpointCommitMatcherClaim,
    isGitCheckpointCompareMatcherClaim,
    isGitCheckpointDiffMatcherClaim,
    isGitArcWaitMatcherClaim,
    parseGitArcCommand,
    parseGitArcReceipt,
    parseGitArcWaitRef,
    parseGitCheckpointCommitCommand,
    parseGitCheckpointCompareOutput,
    parseGitCheckpointDiffArtifactId,
    parseGitCheckpointDiffOutput,
    parseGitCheckpointProposalId,
} from "./command-matchers/git-checkpoints";
import { GIT_COMMAND_MATCHERS } from "./command-matchers/git-commands";
import {
    buildCommandPathPart,
    buildDisplayPathPart,
    buildReadCommandSummary,
    createEmptyCommandSummaryStats,
    formatThreadCommandPath,
    mergeCommandSummaryStats,
    pathsEqual,
    summarizeDisplayParts,
} from "./command-matchers/helpers";
import { POSIX_COMMAND_MATCHERS } from "./command-matchers/posix";
import { POWERSHELL_COMMAND_MATCHERS } from "./command-matchers/powershell";
import { COMMON_COMMAND_MATCHERS } from "./command-matchers/shared";
import {
    consumeNextCommandStage,
    getCommandShellGroup,
    unwrapShellCommand,
} from "./command-matchers/shells";
import {
    getWorkbenchThreadRecallSummaryDisplay,
    isThreadContextMatcherClaim,
    parseWorkbenchThreadRecallCommand,
    THREAD_CONTEXT_COMMAND_MATCHERS,
} from "./command-matchers/thread-context";
import type { WorkbenchThreadRecallOperation } from "./command-matchers/thread-context";
import type {
    CommandShell,
    CommandDisplayContext,
    ParsedCommandDisplayContext,
    ThreadCommandDetailRow,
    ThreadCommandDetailTarget,
    ThreadCommandDisplay,
    ThreadCommandDisplayPart,
    ThreadCommandSummaryDisplay,
    ThreadCommandSummaryStats,
} from "./command-matchers/types";
import {
    isWorkbenchTaskStatusMatcherClaim,
    isWorkbenchTaskTitleSetMatcherClaim,
    parseWorkbenchFeedbackCommand,
    parseWorkbenchMessageCommand,
    parseWorkbenchSubagentCommand,
    parseWorkbenchTaskStatusCommand,
    parseWorkbenchTaskTitleCommand,
    parseWorkbenchTodoCommand,
    parseWorkbenchVisCommand,
    type WorkbenchTaskStatusCommand,
    WORKBENCH_CLI_COMMAND_MATCHERS,
} from "./command-matchers/workbench-cli";
import {
    getWorkbenchMcpCommandDisplay,
    getWorkbenchMcpCommandRoute,
    getWorkbenchMcpShellCommandItem,
    shouldUseWorkbenchMcpSpecializedRenderer,
} from "./command-matchers/workbench-mcp";

const MAX_CACHED_COMMAND_DISPLAY_CONTEXTS = 8;
const commandDisplayCache = new WeakMap<CommandAction[], Map<string, ThreadCommandDisplay>>();
const commandDisplayContextIdentity = new WeakMap<object, number>();
let nextCommandDisplayContextIdentity = 1;

function getCommandDisplayContextIdentity(value: object | undefined) {
  if (!value) {
    return 0;
  }

  const cachedIdentity = commandDisplayContextIdentity.get(value);
  if (cachedIdentity) {
    return cachedIdentity;
  }

  const identity = nextCommandDisplayContextIdentity;
  nextCommandDisplayContextIdentity += 1;
  commandDisplayContextIdentity.set(value, identity);
  return identity;
}

function getCommandDisplayCacheKey({
  command,
  cwd,
  knownSkills,
  projectRootPath,
  shell,
  workspaceRoots,
}: CommandDisplayContext) {
  return [
    command.length,
    command,
    cwd.length,
    cwd,
    projectRootPath?.length ?? 0,
    projectRootPath ?? "",
    shell ?? "",
    getCommandDisplayContextIdentity(knownSkills),
    getCommandDisplayContextIdentity(workspaceRoots),
  ].join("\0");
}

export {
    CommandMatcher, formatThreadCommandPath, getGitArcMatcherAction,
    isBrowseCommandMatcherClaim,
    isGitCheckpointCommitMatcherClaim,
    isGitCheckpointCompareMatcherClaim,
    isGitCheckpointDiffMatcherClaim,
    isGitArcWaitMatcherClaim,
    isThreadContextMatcherClaim,
    isWorkbenchTaskStatusMatcherClaim,
    isWorkbenchTaskTitleSetMatcherClaim,
    parseBrowseSequenceCommandOutput,
    parseGitArcCommand,
    parseGitArcReceipt, parseGitArcWaitRef, parseGitCheckpointCommitCommand, parseGitCheckpointCompareOutput, parseGitCheckpointDiffArtifactId,
    parseGitCheckpointDiffOutput,
    parseGitCheckpointProposalId, parseWorkbenchFeedbackCommand, parseWorkbenchMessageCommand, parseWorkbenchSubagentCommand, parseWorkbenchTaskStatusCommand, parseWorkbenchTaskTitleCommand,
    parseWorkbenchThreadRecallCommand, parseWorkbenchTodoCommand, parseWorkbenchVisCommand, getWorkbenchThreadRecallSummaryDisplay
};
export { getWorkbenchMcpCommandDisplay, getWorkbenchMcpCommandRoute, getWorkbenchMcpShellCommandItem, shouldUseWorkbenchMcpSpecializedRenderer };
export { getWorkbenchCommandRouteSummaryDisplay, parseWorkbenchFeedbackId } from "./command-matchers/workbench-command-rendering";
export type { WorkbenchCommandRoute, WorkbenchFeedbackOperation, WorkbenchSpecializedOperation, WorkbenchTodoOperation, WorkbenchVisOperation } from "./command-matchers/workbench-command-rendering";
export type {
    CommandShell,
    GitArcCommandAction,
    GitArcCommandIntent,
    GitCheckpointCommitCommandIntent,
    ThreadCommandDetailRow,
    ThreadCommandDetailTarget,
    ThreadCommandDisplay,
    ThreadCommandDisplayPart,
    ThreadCommandSummaryDisplay,
    ThreadCommandSummaryStats,
    WorkbenchTaskStatusCommand,
    WorkbenchThreadRecallOperation,
};

export type ThreadCommandExecutionOutcome = "completed" | "declined" | "failed" | "inProgress" | "timedOut";

type NativeToolItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;
const nativeToolDisplays: Record<string, (item: NativeToolItem, context?: Parameters<typeof getOpenCodeToolDisplay>[1]) => ThreadCommandSummaryDisplay | null> = {
    opencode: getOpenCodeToolDisplay,
    claude: getClaudeToolDisplay,
};

export function getNativeToolDisplay(item: NativeToolItem, context?: Parameters<typeof getOpenCodeToolDisplay>[1]) {
    return item.namespace ? nativeToolDisplays[item.namespace]?.(item, context) ?? null : null;
}

type MatchedCommandDisplay = NonNullable<ReturnType<typeof runThreadCommandMatchers>>;

function cwdName(cwd: string) {
  const parts = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts.at(-1) || cwd;
}

function prefixWorkbenchCommandDisplay(
  display: MatchedCommandDisplay,
  context: ParsedCommandDisplayContext,
) {
  const isPrimaryCwd = context.projectRootPath
    ? pathsEqual(context.cwd, context.projectRootPath)
    : false;
  if (isPrimaryCwd || !/^wb(?:\.cmd)?(?:\s|$)/iu.test(context.unwrappedCommand.trim()) || display.omitFromDisplay) {
    return display;
  }
  const prefix = CommandMatcher.Text(`${cwdName(context.cwd)}: `);
  const summaryParts = [prefix, ...display.summaryParts];
  const ongoingSummaryParts = display.ongoingSummaryParts.length
    ? [prefix, ...display.ongoingSummaryParts]
    : [];
  return {
    ...display,
    ongoingSummaryParts,
    ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts),
    summaryParts,
    summaryText: summarizeDisplayParts(summaryParts),
  };
}

function computeThreadCommandDisplay({
  command,
  commandActions,
  cwd,
  knownSkills,
  projectRootPath,
  shell: shellHint,
  workspaceRoots,
}: CommandDisplayContext): ThreadCommandDisplay {
  const shellResult = unwrapShellCommand(command);
  const shell = shellResult.shell ?? shellHint ?? null;
  const context: ParsedCommandDisplayContext = {
    command,
    commandActions,
    cwd,
    cwdDisplay: formatThreadCommandPath(cwd, { projectRootPath, workspaceRoots }),
    knownSkills,
    projectRootPath,
    shell,
    shellGroup: getCommandShellGroup(shell),
    unwrappedCommand: shellResult.command,
    workspaceRoots,
  };
  const matchedDisplay = runThreadCommandMatchers(context, {
    commonMatchers: [
      ...WORKBENCH_CLI_COMMAND_MATCHERS,
      ...THREAD_CONTEXT_COMMAND_MATCHERS,
      ...GIT_COMMAND_MATCHERS,
      ...GIT_CHECKPOINT_COMMAND_MATCHERS,
      ...BROWSE_COMMAND_MATCHERS,
      ...COMMON_COMMAND_MATCHERS,
    ],
    shellMatchers: getShellCommandMatchers(context.shellGroup),
  });

  if (matchedDisplay) {
    const prefixedDisplay = prefixWorkbenchCommandDisplay(matchedDisplay, context);
    return {
      ...prefixedDisplay,
      cwdDisplay: context.cwdDisplay,
      fullCommand: command,
      shell: context.shell,
      unwrappedCommand: context.unwrappedCommand,
    };
  }

  const actionSummary = summarizeCommandActions(context);
  if (actionSummary) {
    return {
      claimedBy: "command-action",
      cwdDisplay: context.cwdDisplay,
      fullCommand: command,
      omitFromDisplay: false,
      ongoingSummaryParts: actionSummary.ongoingSummaryParts,
      ongoingSummaryText: summarizeDisplayParts(actionSummary.ongoingSummaryParts),
      shell: context.shell,
      showShell: false,
      summaryKind: "matched",
      summaryParts: actionSummary.summaryParts,
      summaryStats: actionSummary.summaryStats,
      summaryText: summarizeDisplayParts(actionSummary.summaryParts),
      unwrappedCommand: context.unwrappedCommand,
    };
  }

  const rawSummaryText = context.unwrappedCommand.replace(/\s+/g, " ").trim();
  return {
    claimedBy: null,
    cwdDisplay: context.cwdDisplay,
    fullCommand: command,
    omitFromDisplay: false,
    // The row's shimmer says it is running; the text is the command alone.
    ongoingSummaryParts: [CommandMatcher.Code(rawSummaryText, { clamp: true })],
    ongoingSummaryText: rawSummaryText,
    shell: context.shell,
    showShell: Boolean(context.shell),
    summaryKind: "raw",
    summaryParts: [CommandMatcher.Code(rawSummaryText, { clamp: true })],
    summaryStats: {
      ...createEmptyCommandSummaryStats(),
      otherCommands: countCommandStages(context.unwrappedCommand, context.shellGroup),
    },
    summaryText: rawSummaryText,
    unwrappedCommand: context.unwrappedCommand,
  };
}

export function getThreadCommandDisplay(context: CommandDisplayContext): ThreadCommandDisplay {
  let contextCache = commandDisplayCache.get(context.commandActions);
  if (!contextCache) {
    contextCache = new Map();
    commandDisplayCache.set(context.commandActions, contextCache);
  }

  const cacheKey = getCommandDisplayCacheKey(context);
  const cachedDisplay = contextCache.get(cacheKey);
  if (cachedDisplay) {
    contextCache.delete(cacheKey);
    contextCache.set(cacheKey, cachedDisplay);
    return cachedDisplay;
  }

  const display = computeThreadCommandDisplay(context);
  if (contextCache.size >= MAX_CACHED_COMMAND_DISPLAY_CONTEXTS) {
    const oldestCacheKey = contextCache.keys().next().value;
    if (oldestCacheKey !== undefined) {
      contextCache.delete(oldestCacheKey);
    }
  }
  contextCache.set(cacheKey, display);
  return display;
}

function getShellCommandMatchers(shellGroup: ParsedCommandDisplayContext["shellGroup"]) {
  switch (shellGroup) {
    case "powershell":
      return POWERSHELL_COMMAND_MATCHERS;
    case "cmd":
      return CMD_COMMAND_MATCHERS;
    case "posix":
      return POSIX_COMMAND_MATCHERS;
    default:
      return [];
  }
}

function summarizeCommandActions(context: ParsedCommandDisplayContext) {
  const ongoingSummaryParts: ThreadCommandDisplayPart[] = [];
  const summaryParts: ThreadCommandDisplayPart[] = [];
  const summaryStats = createEmptyCommandSummaryStats();
  let hasKnownAction = false;

  for (const action of context.commandActions) {
    const actionSummary = summarizeCommandAction(action, context);
    if (!actionSummary) {
      summaryStats.otherCommands += 1;
      continue;
    }

    if (summaryParts.length) {
      summaryParts.push(CommandMatcher.Separator());
      ongoingSummaryParts.push(CommandMatcher.Separator());
    }

    hasKnownAction = true;
    ongoingSummaryParts.push(...actionSummary.ongoingSummaryParts);
    summaryParts.push(...actionSummary.summaryParts);
    mergeCommandSummaryStats(summaryStats, actionSummary.summaryStats);
  }

  return hasKnownAction
    ? {
      ongoingSummaryParts,
      summaryParts,
      summaryStats,
    }
    : null;
}

function summarizeCommandAction(
  action: CommandAction,
  context: ParsedCommandDisplayContext,
): {
  ongoingSummaryParts: ThreadCommandDisplayPart[];
  summaryParts: ThreadCommandDisplayPart[];
  summaryStats: Partial<ThreadCommandSummaryStats>;
} | null {
  switch (action.type) {
    case "read": {
      const readSummary = buildReadCommandSummary(action.path, context);
      return {
        ongoingSummaryParts: readSummary?.ongoingSummaryParts ?? [CommandMatcher.Text("Reading file")],
        summaryParts: readSummary?.summaryParts ?? [CommandMatcher.Text("Read file")],
        summaryStats: readSummary?.summaryStats ?? { readFiles: 1 },
      };
    }
    case "listFiles": {
      const pathPart = action.path
        ? buildCommandPathPart(action.path, context)
        : buildDisplayPathPart(context.cwdDisplay);
      return {
        ongoingSummaryParts: pathPart
          ? [CommandMatcher.Text("Listing files under "), pathPart]
          : [CommandMatcher.Text("Listing files")],
        summaryParts: pathPart
          ? [
            CommandMatcher.Text("List files under "),
            pathPart,
          ]
          : [CommandMatcher.Text("List files")],
        summaryStats: { listedFiles: 1 },
      };
    }
    case "search": {
      const queryText = action.query ? `"${action.query}"` : "\"text\"";
      const pathPart = action.path
        ? buildCommandPathPart(action.path, context)
        : null;
      return {
        ongoingSummaryParts: pathPart
          ? [CommandMatcher.Text("Searching for "), CommandMatcher.Code(queryText), CommandMatcher.Text(" in "), pathPart]
          : [CommandMatcher.Text("Searching for "), CommandMatcher.Code(queryText)],
        summaryParts: pathPart
          ? [
            CommandMatcher.Text("Search for "),
            CommandMatcher.Code(queryText),
            CommandMatcher.Text(" in "),
            pathPart,
          ]
          : [
            CommandMatcher.Text("Search for "),
            CommandMatcher.Code(queryText),
          ],
        summaryStats: { searchedFiles: 1 },
      };
    }
    default:
      return null;
  }
}

export function getThreadCommandExecutionOutcome(
  status: CommandExecutionStatus,
  exitCode: number | null,
): ThreadCommandExecutionOutcome {
  if (exitCode === 124) return "timedOut";
  if ((exitCode !== null && exitCode !== 0) || status === "failed") return "failed";
  if (status === "declined") return "declined";
  if (status === "inProgress") return "inProgress";
  return "completed";
}

export function getThreadMcpToolCallOutcome(
  item: Pick<Extract<ThreadItem, { type: "mcpToolCall" }>, "error" | "status">,
): ThreadCommandExecutionOutcome {
  if (item.status === "inProgress") return "inProgress";
  return item.status === "failed" || Boolean(item.error) ? "failed" : "completed";
}

/** A wb MCP wait that an incoming message cut short; its result text is guidance for the agent, not the user. */
export function isThreadMcpWaitInterruptedBySteer(item: Pick<Extract<ThreadItem, { type: "mcpToolCall" }>, "result">) {
  const result = readGitArcMcpResult(item.result?.structuredContent ?? null);
  return result?.kind === "valid" && result.result.kind === "interruptedBySteer";
}

/** An incoming message ends a wb MCP subagent wait normally, so that wait completed rather than failed. */
export function getThreadSubagentWaitMcpOutcome(
  item: Pick<Extract<ThreadItem, { type: "mcpToolCall" }>, "error" | "result" | "status">,
): ThreadCommandExecutionOutcome {
  return isThreadMcpWaitInterruptedBySteer(item) ? "completed" : getThreadMcpToolCallOutcome(item);
}

export function getThreadCommandOutcomeDisplay(
  display: ThreadCommandSummaryDisplay,
  outcome: ThreadCommandExecutionOutcome,
): ThreadCommandSummaryDisplay {
  // A raw command is its own text; its row shows failure in red rather than a label.
  if (outcome === "completed" || (outcome === "failed" && display.summaryKind === "raw")) return display;
  const ongoingSummaryParts = display.ongoingSummaryParts;
  const leadingContextParts = ongoingSummaryParts[0]?.type === "text" && /:\s$/u.test(ongoingSummaryParts[0].text)
    ? ongoingSummaryParts.slice(0, 1)
    : [];
  const commandSummaryParts = leadingContextParts.length ? ongoingSummaryParts.slice(1) : ongoingSummaryParts;
  const summaryParts = outcome === "inProgress"
    ? ongoingSummaryParts
    : [
      ...leadingContextParts,
      CommandMatcher.Text(outcome === "timedOut" ? "Timed out " : outcome === "failed" ? "Failed " : "Declined "),
      ...lowercaseFirstSummaryPart(commandSummaryParts),
    ];
  return {
    ...display,
    summaryParts,
    summaryText: summarizeDisplayParts(summaryParts),
  };
}

function lowercaseFirstSummaryPart(parts: ThreadCommandDisplayPart[]) {
  let changed = false;
  return parts.map((part) => {
    if (changed || part.type !== "text" || !part.text) return part;
    changed = true;
    return { ...part, text: `${part.text[0].toLowerCase()}${part.text.slice(1)}` };
  });
}

function countCommandStages(
  command: string,
  shellGroup: ParsedCommandDisplayContext["shellGroup"],
) {
  let count = 0;
  let remainingCommand = command;

  while (remainingCommand) {
    const stage = consumeNextCommandStage(remainingCommand, shellGroup);
    if (!stage) {
      break;
    }

    count += 1;
    remainingCommand = stage.remainingCommand ?? "";
  }

  return count || 1;
}
