/*
 * Exports:
 * - COMMON_COMMAND_MATCHERS: shell-agnostic command-summary matchers for builds and git commands. Keywords: thread, command, matcher, git, typescript.
 */

import { buildCommandPathPart } from "./helpers";
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

export const COMMON_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "typescript-no-emit",
    match: ({ stage }) => {
      if (!/\btsc(?:\.(?:cmd|ps1|exe|js))?\b/i.test(stage.text) || !/(?:^|\s)--noEmit(?:\s|$)/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [CommandMatcher.Text("TypeScript build (no emit)")],
      });
    },
  }),
  CommandMatcher({
    id: "typescript-build",
    match: ({ stage }) => {
      if (!/\btsc(?:\.(?:cmd|ps1|exe|js))?\b/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [CommandMatcher.Text("TypeScript build")],
      });
    },
  }),
  CommandMatcher({
    id: "git-status",
    match: ({ stage }) => {
      if (!/^git\s+status(?:\s|$)/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [CommandMatcher.Text("Git status")],
      });
    },
  }),
  CommandMatcher({
    id: "git-diff-stat",
    match: ({ stage }) => {
      if (!/^git\s+diff(?:\s|$)/i.test(stage.text) || !/(?:^|\s)--stat(?:\s|$)/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [CommandMatcher.Text("Git diff (stat)")],
      });
    },
  }),
  CommandMatcher({
    id: "git-diff-path",
    match: (context) => {
      if (!/^git\s+diff(?:\s|$)/i.test(context.stage.text) || /(?:^|\s)--stat(?:\s|$)/i.test(context.stage.text)) {
        return null;
      }

      const pathSeparatorIndex = context.stage.text.indexOf(" -- ");
      if (pathSeparatorIndex < 0) {
        return null;
      }

      const pathText = context.stage.text.slice(pathSeparatorIndex + 4).trim();
      if (!pathText) {
        return null;
      }

      const pathParts = tokenizeGitDiffPaths(pathText)
        .map((path) => buildCommandPathPart(path, context))
        .filter(Boolean);
      if (!pathParts.length) {
        return null;
      }

      const summaryParts = [CommandMatcher.Text("Git diff for ")] as ReturnType<typeof CommandMatcher.Text>[];
      pathParts.forEach((pathPart, index) => {
        if (!pathPart) {
          return;
        }

        if (index) {
          summaryParts.push(CommandMatcher.Text(", "));
        }

        summaryParts.push(pathPart);
      });

      return CommandMatcher.Result({
        summaryParts,
      });
    },
  }),
];

function tokenizeGitDiffPaths(pathText: string) {
  const tokens: string[] = [];
  let index = 0;

  while (index < pathText.length) {
    while (index < pathText.length && /\s/.test(pathText[index])) {
      index += 1;
    }

    if (index >= pathText.length) {
      break;
    }

    let token = "";

    while (index < pathText.length && !/\s/.test(pathText[index])) {
      const character = pathText[index];
      const nextCharacter = pathText[index + 1] ?? "";

      if (character === "'") {
        index += 1;
        while (index < pathText.length) {
          const quotedCharacter = pathText[index];
          const followingCharacter = pathText[index + 1] ?? "";

          if (quotedCharacter === "'" && followingCharacter === "'") {
            token += "'";
            index += 2;
            continue;
          }

          if (quotedCharacter === "'") {
            index += 1;
            break;
          }

          token += quotedCharacter;
          index += 1;
        }
        continue;
      }

      if (character === "\"") {
        index += 1;
        while (index < pathText.length) {
          const quotedCharacter = pathText[index];
          if (quotedCharacter === "\\") {
            token += pathText[index + 1] ?? "";
            index += 2;
            continue;
          }

          if (quotedCharacter === "\"") {
            index += 1;
            break;
          }

          token += quotedCharacter;
          index += 1;
        }
        continue;
      }

      if (character === "`") {
        token += nextCharacter;
        index += 2;
        continue;
      }

      token += character;
      index += 1;
    }

    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}
