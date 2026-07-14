/*
 * Exports:
 * - GIT_COMMAND_MATCHERS: command-summary matchers for bounded thread-owned wb git add, unstage, and commit operations. Keywords: thread, command, matcher, git, commit.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

export const GIT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-git.selection",
    match: ({ stage }) => {
      const match = stage.text.trim().match(/^wb(?:\.cmd)?\s+git\s+(add|unstage)(?:\s|$)/iu);
      if (!match) return null;
      const adds = match[1].toLowerCase() === "add";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(adds ? "Selecting files for commit" : "Removing files from commit selection")],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(adds ? "Selected files for commit" : "Removed files from commit selection")],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-git.commit",
    match: ({ stage }) => {
      if (!/^wb(?:\.cmd)?\s+git\s+commit(?:\s|$)/iu.test(stage.text.trim())) return null;
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text("Committing selected files")],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Committed selected files")],
      });
    },
  }),
];
