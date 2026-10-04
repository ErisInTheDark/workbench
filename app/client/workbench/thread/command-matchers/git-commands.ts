/*
 * Exports:
 * - GIT_COMMAND_MATCHERS: shared summaries for wb git selection, commit, and repo warming.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";
import { getWorkbenchCommandRendering } from "./workbench-command-rendering";
import { tokenizeCommand } from "./helpers";

export const GIT_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-git.repo",
    match: ({ stage }) => {
      const tokens = tokenizeCommand(stage.text.trim());
      if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "")
        || tokens[1]?.toLowerCase() !== "git" || tokens[2]?.toLowerCase() !== "repo") return null;
      const operand = tokens[3];
      if (!operand || operand.startsWith("-")) return null;
      if (tokens.length !== 4 && (tokens.length !== 6 || tokens[4] !== "--kind")) return null;
      // SSH user/authority @ is not the CLI's optional repository ref separator.
      const scheme = operand.indexOf("://");
      const pathStart = scheme >= 0 ? operand.indexOf("/", scheme + 3) : operand.indexOf(":");
      const at = pathStart < 0 ? -1 : operand.indexOf("@", pathStart);
      if (at === operand.length - 1) return null;
      return getWorkbenchCommandRendering("git_repo", {
        url: at < 0 ? operand : operand.slice(0, at),
        ...(at < 0 ? {} : { ref: operand.slice(at + 1) }),
        ...(tokens.length === 6 ? { kind: tokens[5]! } : {}),
      })?.result ?? null;
    },
  }),
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
