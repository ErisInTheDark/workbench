/*
 * Exports:
 * - THREAD_CONTEXT_COMMAND_MATCHERS: command-summary matcher for wb thread recall reads and compatibility aliases. Keywords: thread, recall, context, command matcher, cli.
 * - isThreadContextMatcherClaim: detect thread context matcher ids for dedicated thread disclosure rendering. Keywords: thread, context, disclosure.
 * - WorkbenchThreadRecallOperation/parseWorkbenchThreadRecallCommand: typed recall intent shared by CLI and MCP presentation.
 * - getWorkbenchThreadRecallSummaryDisplay: build compact invocation or result-aware recall summaries.
 */

import type { WorkbenchThreadRecallOutputSummary, WorkbenchThreadRecallRecordGroup } from "../thread-recall-output";
import { CommandMatcher } from "./core";
import { createEmptyCommandSummaryStats, summarizeDisplayParts, tokenizeCommand } from "./helpers";
import type { CommandMatcherDefinition, ThreadCommandDisplayPart, ThreadCommandSummaryDisplay } from "./types";

const THREAD_CONTEXT_MATCHER_ID = "thread-context.read";

export interface WorkbenchThreadRecallOperation {
  action: "expand" | "recall" | "search";
  query: string | null;
}

function readFlagValue(tokens: readonly string[], flag: string) {
  const exactFlag = `--${flag}`;
  const assignmentPrefix = `${exactFlag}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === exactFlag) return tokens[index + 1] ?? null;
    if (token.startsWith(assignmentPrefix)) return token.slice(assignmentPrefix.length) || null;
  }
  return null;
}

export function parseWorkbenchThreadRecallCommand(command: string): WorkbenchThreadRecallOperation | null {
  const tokens = tokenizeCommand(command.trim());
  if (
    !tokens
    || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")
    || tokens[1]?.toLowerCase() !== "thread"
    || !/^(?:recall|context)$/iu.test(tokens[2] ?? "")
  ) {
    return null;
  }

  const requestedAction = tokens[3]?.toLowerCase();
  const action = requestedAction === "search" || requestedAction === "expand"
    ? requestedAction
    : "recall";
  return {
    action,
    query: action === "search" ? readFlagValue(tokens, "query") : null,
  };
}

const GROUP_ORDER: WorkbenchThreadRecallRecordGroup[] = ["user", "agent", "plan", "questionnaire"];

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function fullGroupLabel(group: WorkbenchThreadRecallRecordGroup, count: number) {
  switch (group) {
    case "user": return `${count} ${pluralize(count, "user message")}`;
    case "agent": return `${count} ${pluralize(count, "agent message")}`;
    case "questionnaire": return `${count} ${pluralize(count, "questionnaire response")}`;
    case "plan": return `${count} ${pluralize(count, "plan")}`;
  }
}

function compactGroupLabel(group: WorkbenchThreadRecallRecordGroup, count: number) {
  return `${count} ${group}`;
}

function resultCountParts(summary: WorkbenchThreadRecallOutputSummary) {
  const groups = GROUP_ORDER.filter((group) => summary.recordCounts[group] > 0);
  if (summary.recordCount === 0) return [CommandMatcher.Text("Recalled no records")];
  if (groups.length === 1) {
    const group = groups[0]!;
    return [CommandMatcher.Text(`Recalled ${fullGroupLabel(group, summary.recordCounts[group])}`)];
  }
  return [
    CommandMatcher.Text(`Recalled ${summary.recordCount} records · `),
    CommandMatcher.Text(groups.map((group) => compactGroupLabel(group, summary.recordCounts[group])).join(", ")),
  ];
}

function searchResultParts(operation: WorkbenchThreadRecallOperation, summary: WorkbenchThreadRecallOutputSummary) {
  const total = summary.searchMatches?.total ?? summary.recordCount;
  const shown = summary.searchMatches?.shown ?? summary.recordCount;
  const parts: ThreadCommandDisplayPart[] = [
    CommandMatcher.Text(total === 0 ? "Found no matches" : `Found ${total} ${pluralize(total, "match", "matches")}`),
  ];
  if (operation.query) parts.push(CommandMatcher.Text(" for "), CommandMatcher.Code(operation.query));
  if (shown < total) {
    parts.push(CommandMatcher.Text(` · ${shown} shown`));
    return parts;
  }
  const groups = GROUP_ORDER.filter((group) => summary.recordCounts[group] > 0);
  if (groups.length > 1) {
    parts.push(
      CommandMatcher.Text(" · "),
      CommandMatcher.Text(groups.map((group) => compactGroupLabel(group, summary.recordCounts[group])).join(", ")),
    );
  }
  return parts;
}

function invocationParts(operation: WorkbenchThreadRecallOperation, ongoing: boolean) {
  if (operation.action === "search") {
    return [
      CommandMatcher.Text(ongoing ? "Searching thread history" : "Searched thread history"),
      ...(operation.query ? [CommandMatcher.Text(" for "), CommandMatcher.Code(operation.query)] : []),
    ];
  }
  if (operation.action === "expand") {
    return [CommandMatcher.Text(ongoing ? "Recalling thread history from position" : "Recalled thread history from position")];
  }
  return [CommandMatcher.Text(ongoing ? "Recalling thread history" : "Recalled thread history")];
}

export function getWorkbenchThreadRecallSummaryDisplay(
  operation: WorkbenchThreadRecallOperation,
  outputSummary: WorkbenchThreadRecallOutputSummary | null = null,
): ThreadCommandSummaryDisplay {
  const ongoingSummaryParts = invocationParts(operation, true);
  const summaryParts = outputSummary
    ? operation.action === "search"
      ? searchResultParts(operation, outputSummary)
      : resultCountParts(outputSummary)
    : invocationParts(operation, false);
  return {
    claimedBy: THREAD_CONTEXT_MATCHER_ID,
    omitFromDisplay: false,
    ongoingSummaryParts,
    ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts),
    shell: null,
    showShell: false,
    summaryKind: "matched",
    summaryParts,
    summaryStats: createEmptyCommandSummaryStats(),
    summaryText: summarizeDisplayParts(summaryParts),
  };
}

export const THREAD_CONTEXT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: THREAD_CONTEXT_MATCHER_ID,
    match: ({ stage, summaryParts }) => {
      const operation = parseWorkbenchThreadRecallCommand(stage.text);
      if (summaryParts.length || !operation) return null;
      const display = getWorkbenchThreadRecallSummaryDisplay(operation);

      return CommandMatcher.Result({
        ongoingSummaryParts: display.ongoingSummaryParts,
        remainingCommand: null,
        stop: true,
        summaryParts: display.summaryParts,
      });
    },
  }),
];

export function isThreadContextMatcherClaim(value: string | null | undefined) {
  return String(value ?? "")
    .split(",")
    .map((matcherId) => matcherId.trim())
    .includes(THREAD_CONTEXT_MATCHER_ID);
}
