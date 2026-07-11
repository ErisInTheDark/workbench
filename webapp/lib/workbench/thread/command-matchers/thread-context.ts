/*
 * Exports:
 * - THREAD_CONTEXT_COMMAND_MATCHERS: command-summary matcher for wb thread context reads. Keywords: thread, context, command matcher, cli.
 * - isThreadContextMatcherClaim: detect thread context matcher ids for dedicated thread disclosure rendering. Keywords: thread, context, disclosure.
 */

import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const THREAD_CONTEXT_MATCHER_ID = "thread-context.read";

export const THREAD_CONTEXT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: THREAD_CONTEXT_MATCHER_ID,
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length || !/^wb(?:\.cmd)?\s+thread\s+context(?:\s|$)/iu.test(stage.text.trim())) {
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
