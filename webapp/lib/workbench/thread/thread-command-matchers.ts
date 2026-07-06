/*
 * Exports:
 * - CommandMatcher: builder namespace for command-summary matchers, results, and summary parts. Keywords: thread, command, matcher, builder.
 * - ThreadCommandSummaryDisplay: shared summary-display shape for single-command and grouped command labels. Keywords: thread, command, summary, aggregate.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - ThreadCommandDetailRow/ThreadCommandDetailTarget: structured detail rows rendered inside command disclosures. Keywords: thread, command, details, sequence.
 * - ThreadCommandSummaryStats: aggregate command-summary counts for grouped command labels. Keywords: thread, command, summary, aggregate.
 * - ThreadCommandDisplay: parsed command-summary metadata for thread command rendering. Keywords: thread, command, summary, shell, omit.
 * - formatThreadCommandPath: resolve command paths into project-relative forward-slash display text. Keywords: path, command, relative, display.
 * - isBrowseWebRequestMatcherClaim/parseBrowseSequenceCommandOutput: detect and parse Browse request command output. Keywords: browse, sequence, command.
 * - isGitCheckpointDiffMatcherClaim: detect checkpoint diff matcher ids for specialized command-output rendering. Keywords: thread, command, checkpoint, diff.
 * - parseGitCheckpointDiffArtifactId: parse compact checkpoint diff output for a stored full-diff artifact id. Keywords: checkpoint, diff, artifact.
 * - parseGitCheckpointDiffOutput: parse checkpoint diff command output into file-change display entries. Keywords: checkpoint, diff, file change.
 * - getThreadCommandDisplay: unwrap shell launchers and describe common command patterns with staged shell matchers. Keywords: thread, command, matcher, shell.
 * - getThreadCommandBlockDisplay: aggregate multiple command displays into one grouped summary label. Keywords: thread, command, summary, aggregate.
 */

import type { CommandAction } from "../../codex/generated/app-server/v2/CommandAction";
import {
  BROWSE_WEB_REQUEST_COMMAND_MATCHERS,
  isBrowseWebRequestMatcherClaim,
  parseBrowseSequenceCommandOutput,
} from "./command-matchers/browse-web-requests";
import { CMD_COMMAND_MATCHERS } from "./command-matchers/cmd";
import { COPILOT_COMMAND_MATCHERS } from "./command-matchers/copilot-tool-calls";
import { CommandMatcher, runThreadCommandMatchers } from "./command-matchers/core";
import {
  GIT_CHECKPOINT_COMMAND_MATCHERS,
  isGitCheckpointDiffMatcherClaim,
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
} from "./command-matchers/git-checkpoints";
import {
    buildCommandPathPart,
    buildDisplayPathPart,
    buildReadCommandSummary,
    countKnownCommandSummaryStats,
    createEmptyCommandSummaryStats,
    formatThreadCommandPath,
    mergeCommandSummaryStats,
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
import type {
    CommandDisplayContext,
    ParsedCommandDisplayContext,
    ThreadCommandDisplay,
    ThreadCommandDisplayPart,
    ThreadCommandDetailRow,
    ThreadCommandDetailTarget,
    ThreadCommandSummaryDisplay,
    ThreadCommandSummaryStats,
} from "./command-matchers/types";

type KnownCommandSummaryStatKey = Exclude<keyof ThreadCommandSummaryStats, "otherCommands">;

const COMMAND_BLOCK_SUMMARY_CATEGORIES: Array<{
  format: (count: number) => string;
  key: KnownCommandSummaryStatKey;
}> = [
  {
    key: "skillLoads",
    format: (count) => `loaded ${count} ${pluralize(count, "skill")}`,
  },
  {
    key: "readFiles",
    format: (count) => `read ${count} ${pluralize(count, "file")}`,
  },
  {
    key: "searchedFiles",
    format: (count) => `searched ${count} ${pluralize(count, "file")}`,
  },
  {
    key: "listedFiles",
    format: (count) => count === 1
      ? "listed files"
      : `listed files ${count} times`,
  },
  {
    key: "deletedPaths",
    format: (count) => count === 1
      ? "deleted 1 path"
      : `deleted ${count} paths`,
  },
  {
    key: "pathChecks",
    format: (count) => count === 1
      ? "checked 1 path"
      : `checked ${count} paths`,
  },
  {
    key: "gitStatusChecks",
    format: (count) => count === 1
      ? "checked git status"
      : `checked git status ${count} times`,
  },
  {
    key: "gitDiffChecks",
    format: (count) => count === 1
      ? "checked git diff"
      : `checked git diff ${count} times`,
  },
  {
    key: "typescriptValidations",
    format: (count) => count === 1
      ? "validated TypeScript"
      : `validated TypeScript ${count} times`,
  },
  {
    key: "typescriptBuilds",
    format: (count) => count === 1
      ? "built TypeScript"
      : `built TypeScript ${count} times`,
  },
  {
    key: "gitCheckpointCreates",
    format: (count) => count === 1
      ? "created a git checkpoint"
      : `created ${count} git checkpoints`,
  },
  {
    key: "gitCheckpointDiffs",
    format: (count) => count === 1
      ? "diffed against a git checkpoint"
      : `diffed against git checkpoints ${count} times`,
  },
  {
    key: "gitCheckpointRestores",
    format: (count) => count === 1
      ? "restored a git checkpoint"
      : `restored git checkpoints ${count} times`,
  },
  {
    key: "webRequests",
    format: (count) => count === 1
      ? "made a web request"
      : `made ${count} web requests`,
  },
];

export { CommandMatcher, formatThreadCommandPath };
export { isBrowseWebRequestMatcherClaim, isGitCheckpointDiffMatcherClaim, parseBrowseSequenceCommandOutput, parseGitCheckpointDiffArtifactId, parseGitCheckpointDiffOutput };
export type {
    ThreadCommandDisplay,
    ThreadCommandDisplayPart,
    ThreadCommandDetailRow,
    ThreadCommandDetailTarget,
    ThreadCommandSummaryDisplay,
    ThreadCommandSummaryStats
};

export function getThreadCommandDisplay({
  command,
  commandActions,
  cwd,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: CommandDisplayContext): ThreadCommandDisplay {
  const shellResult = unwrapShellCommand(command);
  const context: ParsedCommandDisplayContext = {
    command,
    commandActions,
    cwd,
    cwdDisplay: formatThreadCommandPath(cwd, { projectRootPath, workspaceRoots }),
    knownSkills,
    projectRootPath,
    shell: shellResult.shell,
    shellGroup: getCommandShellGroup(shellResult.shell),
    unwrappedCommand: shellResult.command,
    workspaceRoots,
  };
  const matchedDisplay = runThreadCommandMatchers(context, {
    commonMatchers: [
      ...COPILOT_COMMAND_MATCHERS,
      ...GIT_CHECKPOINT_COMMAND_MATCHERS,
      ...BROWSE_WEB_REQUEST_COMMAND_MATCHERS,
      ...COMMON_COMMAND_MATCHERS,
    ],
    shellMatchers: getShellCommandMatchers(context.shellGroup),
  });

  if (matchedDisplay) {
    return {
      ...matchedDisplay,
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

export function getThreadCommandBlockDisplay({
  items,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  items: Array<Pick<CommandDisplayContext, "command" | "commandActions" | "cwd">>;
  knownSkills?: CommandDisplayContext["knownSkills"];
  projectRootPath?: string;
  workspaceRoots?: CommandDisplayContext["workspaceRoots"];
}): ThreadCommandSummaryDisplay {
  const summaryStats = createEmptyCommandSummaryStats();
  const summaryCategoryOrder: KnownCommandSummaryStatKey[] = [];
  const seenSummaryCategories = new Set<KnownCommandSummaryStatKey>();

  for (const item of items) {
    const display = getThreadCommandDisplay({
      command: item.command,
      commandActions: item.commandActions,
      cwd: item.cwd,
      knownSkills,
      projectRootPath,
      workspaceRoots,
    });
    for (const key of getKnownCommandSummaryCategoryKeys(display.summaryStats)) {
      if (seenSummaryCategories.has(key)) {
        continue;
      }

      seenSummaryCategories.add(key);
      summaryCategoryOrder.push(key);
    }
    mergeCommandSummaryStats(summaryStats, display.summaryStats);
  }

  const summaryText = formatCommandBlockSummaryText(summaryStats, items.length, summaryCategoryOrder);
  return {
    claimedBy: "command-block",
    omitFromDisplay: false,
    shell: null,
    showShell: false,
    summaryKind: "matched",
    summaryParts: [CommandMatcher.Text(summaryText)],
    summaryStats,
    summaryText,
  };
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
    }

    hasKnownAction = true;
    summaryParts.push(...actionSummary.summaryParts);
    mergeCommandSummaryStats(summaryStats, actionSummary.summaryStats);
  }

  return hasKnownAction
    ? {
      summaryParts,
      summaryStats,
    }
    : null;
}

function summarizeCommandAction(
  action: CommandAction,
  context: ParsedCommandDisplayContext,
): {
  summaryParts: ThreadCommandDisplayPart[];
  summaryStats: Partial<ThreadCommandSummaryStats>;
} | null {
  switch (action.type) {
    case "read": {
      const readSummary = buildReadCommandSummary(action.path, context);
      return {
        summaryParts: readSummary?.summaryParts ?? [CommandMatcher.Text("Read file")],
        summaryStats: readSummary?.summaryStats ?? { readFiles: 1 },
      };
    }
    case "listFiles": {
      const pathPart = action.path
        ? buildCommandPathPart(action.path, context)
        : buildDisplayPathPart(context.cwdDisplay);
      return {
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

function formatCommandBlockSummaryText(
  summaryStats: ThreadCommandSummaryStats,
  fallbackCommandCount: number,
  summaryCategoryOrder = getKnownCommandSummaryCategoryKeys(summaryStats),
) {
  const segments = summaryCategoryOrder
    .map((key) => {
      const count = summaryStats[key];
      const category = COMMAND_BLOCK_SUMMARY_CATEGORIES.find((candidate) => candidate.key === key);
      return count && category ? category.format(count) : null;
    })
    .filter((segment): segment is string => Boolean(segment));

  if (countKnownCommandSummaryStats(summaryStats) && summaryStats.otherCommands) {
    segments.push(`ran ${summaryStats.otherCommands} other ${pluralize(summaryStats.otherCommands, "command")}`);
  }

  if (!segments.length) {
    return `Ran ${fallbackCommandCount} ${pluralize(fallbackCommandCount, "command")}`;
  }

  const [firstSegment, ...remainingSegments] = segments;
  const normalizedFirstSegment = `${firstSegment.slice(0, 1).toUpperCase()}${firstSegment.slice(1)}`;
  return [normalizedFirstSegment, ...remainingSegments].join(", ");
}

function getKnownCommandSummaryCategoryKeys(stats: ThreadCommandSummaryStats) {
  return COMMAND_BLOCK_SUMMARY_CATEGORIES
    .map((category) => category.key)
    .filter((key) => stats[key] > 0);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
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
