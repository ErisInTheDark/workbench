/*
 * Exports:
 * - GIT_COMMAND_MATCHERS: command-summary matchers for bounded thread-owned wb git add, unstage, and commit operations. Keywords: thread, command, matcher, git, commit.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";
import { getWorkbenchCommandRendering } from "./workbench-command-rendering";

export const GIT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-git.selection",
    match: ({ stage }) => {
      const match = stage.text.trim().match(/^wb(?:\.cmd)?\s+git\s+(add|unstage)(?:\s|$)/iu);
      if (!match) return null;
      const adds = match[1].toLowerCase() === "add";
      return getWorkbenchCommandRendering(adds ? "git_add" : "git_unstage", {})?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-git.commit",
    match: ({ stage }) => {
      if (!/^wb(?:\.cmd)?\s+git\s+commit(?:\s|$)/iu.test(stage.text.trim())) return null;
      return getWorkbenchCommandRendering("git_commit", {})?.result ?? null;
    },
  }),
];
