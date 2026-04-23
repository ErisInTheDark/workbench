/*
 * Exports:
 * - CMD_COMMAND_MATCHERS: Windows cmd stage matchers for file listings, reads, and searches. Keywords: thread, command, matcher, cmd.
 */

import {
  buildCommandPathPart,
  buildDisplayPathPart,
} from "./helpers";
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

interface ParsedCmdStage {
  commandName: string | null;
  tokens: string[];
}

export const CMD_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "cmd.list-files",
    match: (context) => {
      const parsedStage = parseCmdStage(context.stage.text);
      if (parsedStage.commandName !== "dir") {
        return null;
      }

      const positionalArguments = getCmdPositionalArguments(parsedStage);
      const pathPart = positionalArguments[0]
        ? buildCommandPathPart(positionalArguments[0], context)
        : buildDisplayPathPart(context.cwdDisplay);
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text("List files in "),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "cmd.read-type",
    match: (context) => {
      const parsedStage = parseCmdStage(context.stage.text);
      if (parsedStage.commandName !== "type") {
        return null;
      }

      const path = getCmdPositionalArguments(parsedStage)[0];
      const pathPart = path ? buildCommandPathPart(path, context) : null;
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text("Read "),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "cmd.search-findstr",
    match: (context) => {
      const parsedStage = parseCmdStage(context.stage.text);
      if (parsedStage.commandName !== "findstr") {
        return null;
      }

      const pattern = readFindStrPattern(parsedStage);
      if (!pattern) {
        return null;
      }

      const summaryParts = [
        CommandMatcher.Text("Search for "),
        CommandMatcher.Code(`"${pattern}"`),
      ];
      const path = getCmdPositionalArguments(parsedStage).at(-1) ?? null;
      const pathPart = path ? buildCommandPathPart(path, context) : null;
      if (pathPart) {
        summaryParts.push(CommandMatcher.Text(" in "), pathPart);
      }

      return CommandMatcher.Result({ summaryParts });
    },
  }),
];

function parseCmdStage(stageText: string): ParsedCmdStage {
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

    while (index < stageText.length) {
      const character = stageText[index];

      if (escapeNext) {
        token += character;
        escapeNext = false;
        index += 1;
        continue;
      }

      if (character === "^") {
        escapeNext = true;
        index += 1;
        continue;
      }

      if (character === "\"") {
        inDoubleQuote = !inDoubleQuote;
        index += 1;
        continue;
      }

      if (!inDoubleQuote && /\s/.test(character)) {
        break;
      }

      token += character;
      index += 1;
    }

    if (token) {
      tokens.push(token);
    }
  }

  return {
    commandName: tokens[0]?.toLowerCase() ?? null,
    tokens,
  };
}

function getCmdPositionalArguments(parsedStage: ParsedCmdStage) {
  return parsedStage.tokens.slice(1).filter((token) => !token.startsWith("/"));
}

function readFindStrPattern(parsedStage: ParsedCmdStage) {
  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    const literalMatch = token.match(/^\/c:(.+)$/i);
    if (literalMatch) {
      return literalMatch[1];
    }

    if (!token.startsWith("/")) {
      return token;
    }
  }

  return null;
}
