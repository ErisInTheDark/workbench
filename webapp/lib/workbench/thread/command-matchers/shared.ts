/*
 * Exports:
 * - COMMON_COMMAND_MATCHERS: shell-agnostic command-summary matchers for builds and git commands. Keywords: thread, command, matcher, git, typescript.
 */

import { CommandMatcher } from "./core";
import { buildCommandPathPart } from "./helpers";
import type { CommandMatcherDefinition, ThreadCommandDisplayPart } from "./types";

export const COMMON_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "typescript-no-emit",
    match: ({ stage }) => {
      if (!/\btsc(?:\.(?:cmd|ps1|exe|js))?\b/i.test(stage.text) || !/(?:^|\s)--noEmit(?:\s|$)/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryStats: { typescriptValidations: 1 },
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
        summaryStats: { typescriptBuilds: 1 },
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
        summaryStats: { gitStatusChecks: 1 },
        summaryParts: [CommandMatcher.Text("Git status")],
      });
    },
  }),
  CommandMatcher({
    id: "git-ls-files",
    match: (context) => {
      if (!/^git\s+ls-files(?:\s|$)/i.test(context.stage.text)) {
        return null;
      }

      const listsUntrackedFiles = isGitLsFilesUntrackedListing(context.stage.text);
      const path = getGitLsFilesPath(context.stage.text);
      const pathPart = path
        ? buildCommandPathPart(path, context)
        : null;

      return CommandMatcher.Result({
        summaryStats: { listedFiles: 1 },
        summaryParts: pathPart
          ? [
            CommandMatcher.Text(formatGitLsFilesPathPrefix({ listsUntrackedFiles, path })),
            pathPart,
          ]
          : [CommandMatcher.Text(listsUntrackedFiles ? "List untracked files" : "List tracked files")],
      });
    },
  }),
  CommandMatcher({
    id: "git-show",
    match: (context) => {
      if (!/^git\s+show(?:\s|$)/i.test(context.stage.text)) {
        return null;
      }

      const targetPath = getGitShowPath(context.stage.text);
      const pathPart = targetPath
        ? buildCommandPathPart(targetPath, context)
        : null;

      return CommandMatcher.Result({
        summaryStats: { gitDiffChecks: 1 },
        summaryParts: pathPart
          ? [
            CommandMatcher.Text("Git show for "),
            pathPart,
          ]
          : [CommandMatcher.Text("Git show")],
      });
    },
  }),
  CommandMatcher({
    id: "git-blame",
    match: (context) => {
      if (!/^git\s+blame(?:\s|$)/i.test(context.stage.text)) {
        return null;
      }

      const lineRange = getGitBlameLineRange(context.stage.text);
      const targetPath = getGitBlamePath(context.stage.text);
      const pathPart = targetPath
        ? buildCommandPathPart(targetPath, context)
        : null;
      const summaryParts: ThreadCommandDisplayPart[] = [
        CommandMatcher.Text(lineRange ? `Git blame lines ${lineRange} of ` : "Git blame"),
      ];

      if (pathPart) {
        if (!lineRange) {
          summaryParts.push(CommandMatcher.Text(" "));
        }

        summaryParts.push(pathPart);
      }

      return CommandMatcher.Result({
        summaryStats: { readFiles: 1 },
        summaryParts,
      });
    },
  }),
  CommandMatcher({
    id: "git-diff-name-only",
    match: ({ stage }) => {
      if (!/^git\s+diff(?:\s|$)/i.test(stage.text) || !/(?:^|\s)--name-only(?:\s|$)/i.test(stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        summaryStats: { gitDiffChecks: 1 },
        summaryParts: [CommandMatcher.Text("List changed files")],
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
        summaryStats: { gitDiffChecks: 1 },
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
        summaryStats: { gitDiffChecks: 1 },
        summaryParts,
      });
    },
  }),
];

function tokenizeGitDiffPaths(pathText: string) {
  return tokenizeGitArguments(pathText);
}

function getGitShowPath(stageText: string) {
  const tokens = tokenizeGitArguments(stageText.replace(/^git\s+show(?:\s+|$)/i, ""));
  const separatorIndex = tokens.indexOf("--");
  if (separatorIndex >= 0) {
    return tokens.slice(separatorIndex + 1).filter(Boolean).at(-1) ?? null;
  }

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      continue;
    }

    const pathFromRevision = readGitRevisionPath(token);
    if (pathFromRevision) {
      return pathFromRevision;
    }
  }

  return null;
}

function getGitBlameLineRange(stageText: string) {
  const tokens = tokenizeGitArguments(stageText.replace(/^git\s+blame(?:\s+|$)/i, ""));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const inlineRange = token.match(/^-L(\d+)\s*,\s*(\d+)$/i);
    if (inlineRange?.[1] && inlineRange[2]) {
      return `${inlineRange[1]}-${inlineRange[2]}`;
    }

    if (token.toLowerCase() !== "-l") {
      continue;
    }

    const rangeToken = tokens[index + 1] ?? "";
    const range = rangeToken.match(/^(\d+)\s*,\s*(\d+)$/);
    if (range?.[1] && range[2]) {
      return `${range[1]}-${range[2]}`;
    }
  }

  return null;
}

function getGitBlamePath(stageText: string) {
  const tokens = tokenizeGitArguments(stageText.replace(/^git\s+blame(?:\s+|$)/i, ""));
  const separatorIndex = tokens.indexOf("--");
  if (separatorIndex >= 0) {
    return tokens.slice(separatorIndex + 1).filter(Boolean).at(-1) ?? null;
  }

  return getGitPositionalArguments(tokens, getGitBlameValueFlags()).at(-1) ?? null;
}

function getGitLsFilesPath(stageText: string) {
  const argumentText = stageText.replace(/^git\s+ls-files(?:\s+|$)/i, "");
  const argumentsList = tokenizeGitArguments(argumentText);
  const separatorIndex = argumentsList.indexOf("--");
  const pathTokens = separatorIndex >= 0
    ? argumentsList.slice(separatorIndex + 1)
    : argumentsList.filter((token) => !token.startsWith("-"));

  return pathTokens.at(-1) ?? null;
}

function isGitLsFilesUntrackedListing(stageText: string) {
  const argumentText = stageText.replace(/^git\s+ls-files(?:\s+|$)/i, "");
  const argumentsList = tokenizeGitArguments(argumentText);
  return argumentsList.some((argument) => argument === "--others" || argument === "-o");
}

function formatGitLsFilesPathPrefix({
  listsUntrackedFiles,
  path,
}: {
  listsUntrackedFiles: boolean;
  path: string;
}) {
  if (listsUntrackedFiles) {
    return looksLikeTrackedFilePath(path) ? "Check untracked file " : "List untracked files under ";
  }

  return looksLikeTrackedFilePath(path) ? "Check tracked file " : "List tracked files under ";
}

function readGitRevisionPath(token: string) {
  const colonIndex = token.indexOf(":");
  if (colonIndex < 0) {
    return null;
  }

  const path = token.slice(colonIndex + 1).trim();
  return path && !/^[0-9]+$/.test(path) ? path : null;
}

function getGitPositionalArguments(tokens: string[], valueFlags: Set<string>) {
  const positionalArguments: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token || token === "--") {
      continue;
    }

    if (token.startsWith("--")) {
      const [flagName] = token.split("=", 1);
      if (valueFlags.has(flagName.toLowerCase()) && !token.includes("=")) {
        index += 1;
      }

      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const shortFlag = token.slice(0, 2).toLowerCase();
      if (valueFlags.has(shortFlag) && token.length === 2) {
        index += 1;
      }

      continue;
    }

    positionalArguments.push(token);
  }

  return positionalArguments;
}

function getGitBlameValueFlags() {
  return new Set(["-l", "--contents", "--encoding", "--ignore-rev", "--ignore-revs-file"]);
}

function looksLikeTrackedFilePath(path: string | null) {
  if (!path) {
    return false;
  }

  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function tokenizeGitArguments(pathText: string) {
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
