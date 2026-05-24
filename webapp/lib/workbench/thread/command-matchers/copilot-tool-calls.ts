/*
 * Exports:
 * - COPILOT_COMMAND_MATCHERS: shell-agnostic command-summary matchers for Copilot synthetic tool calls such as view. Keywords: thread, command, matcher, copilot, tool.
 */

import { buildReadCommandSummary } from "./helpers";
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

export const COPILOT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "copilot-view-read",
    match: (context) => {
      const argumentsValue = readSyntheticToolArguments(context.stage.text, "view");
      const path = asString(argumentsValue?.path);
      if (!path) {
        return null;
      }

      const readSummary = buildReadCommandSummary(path, context);
      if (!readSummary) {
        return null;
      }

      return CommandMatcher.Result({
        summaryStats: readSummary.summaryStats,
        summaryParts: readSummary.summaryParts,
      });
    },
  }),
];

function readSyntheticToolArguments(stageText: string, toolName: string) {
  const match = stageText.match(new RegExp(`^${escapeRegExp(toolName)}\\s+([\\s\\S]+)$`, "i"));
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsedValue = JSON.parse(match[1]);
    return isRecord(parsedValue)
      ? parsedValue
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
