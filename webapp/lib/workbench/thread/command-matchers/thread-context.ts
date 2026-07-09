/*
 * Exports:
 * - THREAD_CONTEXT_COMMAND_MATCHERS: command-summary matcher for Workbench thread context endpoint reads. Keywords: thread, context, command matcher.
 * - isThreadContextMatcherClaim: detect thread context matcher ids for dedicated thread disclosure rendering. Keywords: thread, context, disclosure.
 */

import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const THREAD_CONTEXT_MATCHER_ID = "thread-context.read";
const THREAD_CONTEXT_ROUTE_PATTERN = /(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/api\/thread-context\/[^'"`\s?#)]+/i;

export const THREAD_CONTEXT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: THREAD_CONTEXT_MATCHER_ID,
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length || !THREAD_CONTEXT_ROUTE_PATTERN.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        hideCommandCwd: true,
        hideCommandOutput: true,
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Checked thread context")],
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
