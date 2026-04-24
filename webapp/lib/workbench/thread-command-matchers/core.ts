/*
 * Exports:
 * - CommandMatcher: builder namespace for stage matchers, result objects, and summary parts. Keywords: thread, command, matcher, builder.
 * - runThreadCommandMatchers: run shell-specific stage matchers until a command is exhausted. Keywords: thread, command, matcher, runner.
 */

import {
  collapseWhitespace,
  createEmptyCommandSummaryStats,
  mergeCommandSummaryStats,
  summarizeDisplayParts,
} from "./helpers";
import { consumeNextCommandStage } from "./shells";
import type {
  CommandMatcherDefinition,
  CommandMatcherResult,
  ParsedCommandDisplayContext,
  ThreadCommandDisplayPart,
} from "./types";

const MAX_MATCH_STEPS = 12;

interface PathPartInput {
  columnNumber?: number | null;
  label?: string;
  lineNumber?: number | null;
  path: string;
}

interface TextPartInput {
  clamp?: boolean;
}

interface CommandMatcherBuilder {
  <T extends CommandMatcherDefinition>(definition: T): T;
  Code: (text: string, options?: TextPartInput) => ThreadCommandDisplayPart;
  Path: (input: PathPartInput) => ThreadCommandDisplayPart;
  Result: (result: CommandMatcherResult) => CommandMatcherResult;
  Separator: () => ThreadCommandDisplayPart;
  Text: (text: string, options?: TextPartInput) => ThreadCommandDisplayPart;
}

export const CommandMatcher: CommandMatcherBuilder = Object.assign(
  function CommandMatcher<T extends CommandMatcherDefinition>(definition: T) {
    return definition;
  },
  {
    Code(text: string, { clamp = false }: TextPartInput = {}) {
      return { clamp, text, type: "text", variant: "code" } satisfies ThreadCommandDisplayPart;
    },
    Path({
      columnNumber = null,
      label,
      lineNumber = null,
      path,
    }: PathPartInput) {
      return {
        columnNumber,
        label,
        lineNumber,
        path,
        type: "path",
      } satisfies ThreadCommandDisplayPart;
    },
    Result({
      hide = false,
      remainingCommand,
      stop = false,
      summaryParts,
      summaryStats,
    }: CommandMatcherResult) {
      return {
        hide,
        remainingCommand,
        stop,
        summaryParts,
        summaryStats,
      } satisfies CommandMatcherResult;
    },
    Separator() {
      return {
        kind: "stage",
        type: "separator",
      } satisfies ThreadCommandDisplayPart;
    },
    Text(text: string, { clamp = false }: TextPartInput = {}) {
      return { clamp, text, type: "text", variant: "plain" } satisfies ThreadCommandDisplayPart;
    },
  },
);

export function runThreadCommandMatchers(
  context: ParsedCommandDisplayContext,
  {
    commonMatchers,
    shellMatchers,
  }: {
    commonMatchers: CommandMatcherDefinition[];
    shellMatchers: CommandMatcherDefinition[];
  },
) {
  const claimedMatcherIds: string[] = [];
  const matchers = [...commonMatchers, ...shellMatchers];
  const summaryParts: ThreadCommandDisplayPart[] = [];
  const summaryStats = createEmptyCommandSummaryStats();
  let hadUnmatchedRemainder = false;
  let remainingCommand: string | null = context.unwrappedCommand;

  for (let index = 0; index < MAX_MATCH_STEPS && remainingCommand; index += 1) {
    const stage = consumeNextCommandStage(remainingCommand, context.shellGroup);
    if (!stage) {
      break;
    }

    let matchedId: string | null = null;
    let matchedResult: CommandMatcherResult | null = null;

    for (const matcher of matchers) {
      const result = matcher.match({
        ...context,
        stage,
        summaryParts,
      });
      if (!result) {
        continue;
      }

      matchedId = matcher.id;
      matchedResult = result;
      break;
    }

    if (!matchedResult) {
      if (!summaryParts.length) {
        return null;
      }

      summaryParts.push(CommandMatcher.Separator());
      summaryParts.push(CommandMatcher.Code(collapseWhitespace(remainingCommand), { clamp: true }));
      summaryStats.otherCommands += countCommandStages(remainingCommand, context.shellGroup);
      hadUnmatchedRemainder = true;
      remainingCommand = null;
      break;
    }

    const shouldRenderSummaryParts = !matchedResult.hide && matchedResult.summaryParts.length > 0;

    if (shouldRenderSummaryParts && summaryParts.length) {
      summaryParts.push(CommandMatcher.Separator());
    }

    if (shouldRenderSummaryParts) {
      summaryParts.push(...matchedResult.summaryParts);
    }
    mergeCommandSummaryStats(summaryStats, matchedResult.summaryStats);
    claimedMatcherIds.push(matchedId ?? "unknown");

    const nextRemainingCommand = matchedResult.remainingCommand === undefined
      ? stage.remainingCommand
      : matchedResult.remainingCommand;

    if (!matchedResult.stop && collapseWhitespace(nextRemainingCommand ?? "") === collapseWhitespace(remainingCommand)) {
      remainingCommand = null;
      break;
    }

    remainingCommand = matchedResult.stop ? null : nextRemainingCommand ?? null;
  }

  if (!summaryParts.length) {
    return null;
  }

  return {
    claimedBy: claimedMatcherIds.join(",") || null,
    showShell: hadUnmatchedRemainder,
    summaryParts,
    summaryKind: "matched" as const,
    summaryStats,
    summaryText: summarizeDisplayParts(summaryParts),
  };
}

function countCommandStages(
  command: string | null | undefined,
  shellGroup: ParsedCommandDisplayContext["shellGroup"],
) {
  let count = 0;
  let remainingCommand = collapseWhitespace(command ?? "");

  while (remainingCommand) {
    const stage = consumeNextCommandStage(remainingCommand, shellGroup);
    if (!stage) {
      break;
    }

    count += 1;
    remainingCommand = collapseWhitespace(stage.remainingCommand ?? "");
  }

  return count || (collapseWhitespace(command ?? "") ? 1 : 0);
}
