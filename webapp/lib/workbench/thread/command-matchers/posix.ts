/*
 * Exports:
 * - POSIX_COMMAND_MATCHERS: POSIX shell stage matchers for reads, listings, and searches. Keywords: thread, command, matcher, bash, sh.
 */

import {
  buildCommandPathPart,
  buildDisplayPathPart,
  buildReadCommandSummary,
} from "./helpers";
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

interface ParsedPosixStage {
  commandName: string | null;
  tokens: string[];
}

export const POSIX_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "posix.read-cat",
    match: (context) => {
      const parsedStage = parsePosixStage(context.stage.text);
      if (parsedStage.commandName !== "cat") {
        return null;
      }

      const path = getPosixPositionalArguments(parsedStage)[0];
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
  CommandMatcher({
    id: "posix.read-sed",
    match: (context) => {
      const parsedStage = parsePosixStage(context.stage.text);
      if (parsedStage.commandName !== "sed" || !hasPosixFlag(parsedStage, "-n")) {
        return null;
      }

      const positionalArguments = getPosixPositionalArguments(parsedStage);
      const lineExpression = positionalArguments[0];
      const path = positionalArguments[1];
      if (!lineExpression || !path) {
        return null;
      }

      const lineMatch = lineExpression.match(/^(\d+)(?:,(\d+))?p$/i);
      if (!lineMatch) {
        return null;
      }

      const startLine = Number(lineMatch[1]);
      const endLine = Number(lineMatch[2] ?? lineMatch[1]);
      const readSummary = buildReadCommandSummary(path, context);
      if (readSummary?.summaryStats.skillLoads) {
        return CommandMatcher.Result({
          summaryStats: readSummary.summaryStats,
          summaryParts: readSummary.summaryParts,
        });
      }

      const pathPart = buildCommandPathPart(path, context);
      if (!pathPart) {
        return null;
      }

      if (startLine === endLine) {
        return CommandMatcher.Result({
          summaryStats: { readFiles: 1 },
          summaryParts: [
            CommandMatcher.Text("Read "),
            CommandMatcher.Path({
              ...pathPart,
              lineNumber: startLine,
            }),
          ],
        });
      }

      return CommandMatcher.Result({
        summaryStats: { readFiles: 1 },
        summaryParts: [
          CommandMatcher.Text(`Read lines ${startLine}-${endLine} of `),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "posix.read-head",
    match: (context) => matchHeadOrTail(context, "head"),
  }),
  CommandMatcher({
    id: "posix.read-tail",
    match: (context) => matchHeadOrTail(context, "tail"),
  }),
  CommandMatcher({
    id: "posix.list-rg-files",
    match: (context) => {
      const parsedStage = parsePosixStage(context.stage.text);
      if (parsedStage.commandName !== "rg" || !hasPosixFlag(parsedStage, "--files")) {
        return null;
      }

      const positionalArguments = getPosixPositionalArguments(parsedStage);
      const pathPart = positionalArguments[0]
        ? buildCommandPathPart(positionalArguments[0], context)
        : buildDisplayPathPart(context.cwdDisplay);
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        summaryStats: { listedFiles: 1 },
        summaryParts: [
          CommandMatcher.Text("List files under "),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "posix.search-rg",
    match: (context) => {
      const parsedStage = parsePosixStage(context.stage.text);
      if (parsedStage.commandName !== "rg" || hasPosixFlag(parsedStage, "--files")) {
        return null;
      }

      const positionalArguments = getPosixPositionalArguments(parsedStage);
      const query = positionalArguments[0];
      if (!query) {
        return null;
      }

      const summaryParts = [
        CommandMatcher.Text("Search for "),
        CommandMatcher.Code(`"${query}"`),
      ];
      const pathPart = positionalArguments[1]
        ? buildCommandPathPart(positionalArguments[1], context)
        : buildDisplayPathPart(context.cwdDisplay);
      if (pathPart) {
        summaryParts.push(CommandMatcher.Text(" in "), pathPart);
      }

      return CommandMatcher.Result({
        summaryParts,
        summaryStats: { searchedFiles: 1 },
      });
    },
  }),
];

function parsePosixStage(stageText: string): ParsedPosixStage {
  const tokens = tokenizePosix(stageText);
  return {
    commandName: tokens[0]?.toLowerCase() ?? null,
    tokens,
  };
}

function tokenizePosix(stageText: string) {
  const tokens: string[] = [];
  let index = 0;

  while (index < stageText.length) {
    while (index < stageText.length && /\s/.test(stageText[index])) {
      index += 1;
    }

    if (index >= stageText.length) {
      break;
    }

    let token = "";
    let escapeNext = false;
    let inDoubleQuote = false;
    let inSingleQuote = false;

    while (index < stageText.length) {
      const character = stageText[index];

      if (escapeNext) {
        token += character;
        escapeNext = false;
        index += 1;
        continue;
      }

      if (inSingleQuote) {
        if (character === "'") {
          inSingleQuote = false;
        } else {
          token += character;
        }
        index += 1;
        continue;
      }

      if (inDoubleQuote) {
        if (character === "\"") {
          inDoubleQuote = false;
        } else if (character === "\\") {
          escapeNext = true;
        } else {
          token += character;
        }
        index += 1;
        continue;
      }

      if (/\s/.test(character)) {
        break;
      }

      if (character === "'") {
        inSingleQuote = true;
        index += 1;
        continue;
      }

      if (character === "\"") {
        inDoubleQuote = true;
        index += 1;
        continue;
      }

      if (character === "\\") {
        escapeNext = true;
        index += 1;
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

function hasPosixFlag(parsedStage: ParsedPosixStage, flag: string) {
  return parsedStage.tokens.includes(flag);
}

function getPosixPositionalArguments(parsedStage: ParsedPosixStage) {
  const argumentsList: string[] = [];

  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    if (!token.startsWith("-")) {
      argumentsList.push(token);
      continue;
    }

    if (token === "-n" || token === "--glob") {
      const nextToken = parsedStage.tokens[index + 1];
      if (nextToken && !nextToken.startsWith("-")) {
        index += 1;
      }
    }
  }

  return argumentsList;
}

function matchHeadOrTail(
  context: Parameters<CommandMatcherDefinition["match"]>[0],
  kind: "head" | "tail",
) {
  const parsedStage = parsePosixStage(context.stage.text);
  if (parsedStage.commandName !== kind) {
    return null;
  }

  const lineCount = readPosixLineCount(parsedStage);
  const path = getPosixPositionalArguments(parsedStage)[0];
  if (lineCount === null || !path) {
    return null;
  }

  const readSummary = buildReadCommandSummary(path, context, `Read ${kind === "head" ? "first" : "last"} ${lineCount} lines of `);
  if (!readSummary) {
    return null;
  }

  return CommandMatcher.Result({
    summaryStats: readSummary.summaryStats,
    summaryParts: readSummary.summaryParts,
  });
}

function readPosixLineCount(parsedStage: ParsedPosixStage) {
  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    if (token === "-n") {
      const nextToken = parsedStage.tokens[index + 1];
      return nextToken && /^\d+$/.test(nextToken) ? Number(nextToken) : null;
    }

    const compactMatch = token.match(/^-n(\d+)$/);
    if (compactMatch) {
      return Number(compactMatch[1]);
    }
  }

  return null;
}
