/*
 * Exports:
 * - POWERSHELL_COMMAND_MATCHERS: PowerShell stage matchers for reads, listings, filters, and searches. Keywords: thread, command, matcher, powershell.
 */

import {
  buildCommandPathPart,
  buildDisplayPathPart,
} from "./helpers";
import { CommandMatcher } from "./core";
import { consumeNextCommandStage } from "./shells";
import type { CommandMatcherDefinition } from "./types";

interface ParsedPowerShellStage {
  commandName: string | null;
  tokens: string[];
}

export const POWERSHELL_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "powershell.read",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["get-content", "gc"])) {
        return null;
      }

      const pathPart = getPowerShellStagePathPart(parsedStage, context);
      if (!pathPart) {
        return null;
      }

      const skip = readPowerShellNumericValue(parsedStage, "-Skip");
      const first = readPowerShellNumericValue(parsedStage, "-First");
      const totalCount = readPowerShellNumericValue(parsedStage, "-TotalCount");
      const selectObjectSummary = skip === null && first === null && totalCount === null
        ? buildPowerShellSelectObjectReadSummary(context, pathPart)
        : null;

      if (selectObjectSummary) {
        return selectObjectSummary;
      }

      if (skip !== null && first !== null) {
        if (first === 1) {
          return CommandMatcher.Result({
            summaryParts: [
              CommandMatcher.Text("Read "),
              CommandMatcher.Path({
                ...pathPart,
                lineNumber: skip + 1,
              }),
            ],
          });
        }

        return CommandMatcher.Result({
          summaryParts: [
            CommandMatcher.Text(`Read lines ${skip + 1}-${skip + first} of `),
            pathPart,
          ],
        });
      }

      if (first !== null) {
        return CommandMatcher.Result({
          summaryParts: [
            CommandMatcher.Text(`Read first ${first} lines of `),
            pathPart,
          ],
        });
      }

      if (totalCount !== null) {
        return CommandMatcher.Result({
          summaryParts: [
            CommandMatcher.Text(`Read first ${totalCount} lines of `),
            pathPart,
          ],
        });
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
    id: "powershell.list-files",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["get-childitem", "dir", "ls"])) {
        return null;
      }

      const includePatterns = splitPowerShellList(readPowerShellNamedValue(parsedStage, ["-Include"]));
      const pathPart = getPowerShellStagePathPart(parsedStage, context) ?? buildDisplayPathPart(context.cwdDisplay);
      if (!pathPart) {
        return null;
      }

      const collectionLabel = hasPowerShellFlag(parsedStage, "-File") || includePatterns.length
        ? "files"
        : "items";
      const locationLabel = hasPowerShellFlag(parsedStage, "-Recurse") ? "under" : "in";

      if (includePatterns.length) {
        return CommandMatcher.Result({
          summaryParts: [
            CommandMatcher.Text("List "),
            CommandMatcher.Code(includePatterns.join(", ")),
            CommandMatcher.Text(` ${collectionLabel} ${locationLabel} `),
            pathPart,
          ],
        });
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text(`List ${collectionLabel} ${locationLabel} `),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.exclude",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["where-object", "?"])) {
        return null;
      }

      const excludedPattern = summarizeWhereObjectExclusion(parsedStage);
      if (!excludedPattern) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text("Exclude "),
          CommandMatcher.Code(excludedPattern),
        ],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.search",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["select-string", "sls"])) {
        return null;
      }

      const pattern = readPowerShellNamedValue(parsedStage, ["-Pattern"]) ?? getPowerShellPositionalArguments(parsedStage)[0];
      if (!pattern) {
        return null;
      }

      const summaryParts = [
        CommandMatcher.Text("Search for "),
        CommandMatcher.Code(`"${formatPatternForDisplay(pattern)}"`),
      ];
      const pathPart = getPowerShellStagePathPart(parsedStage, context);
      if (pathPart) {
        summaryParts.push(CommandMatcher.Text(" in "), pathPart);
      }

      return CommandMatcher.Result({ summaryParts });
    },
  }),
];

function parsePowerShellStage(stageText: string): ParsedPowerShellStage {
  const tokens = tokenizePowerShell(stageText);
  return {
    commandName: tokens[0]?.toLowerCase() ?? null,
    tokens,
  };
}

function tokenizePowerShell(stageText: string) {
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
    while (index < stageText.length && !/\s/.test(stageText[index])) {
      const character = stageText[index];

      if (character === "'") {
        const segment = readPowerShellSingleQuotedSegment(stageText, index);
        token += segment.value;
        index = segment.nextIndex;
        continue;
      }

      if (character === "\"") {
        const segment = readPowerShellDoubleQuotedSegment(stageText, index);
        token += segment.value;
        index = segment.nextIndex;
        continue;
      }

      if (character === "{") {
        const segment = readPowerShellScriptBlock(stageText, index);
        token += segment.value;
        index = segment.nextIndex;
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

function readPowerShellSingleQuotedSegment(stageText: string, startIndex: number) {
  let index = startIndex + 1;
  let value = "";

  while (index < stageText.length) {
    const character = stageText[index];
    const nextCharacter = stageText[index + 1] ?? "";

    if (character === "'" && nextCharacter === "'") {
      value += "'";
      index += 2;
      continue;
    }

    if (character === "'") {
      index += 1;
      break;
    }

    value += character;
    index += 1;
  }

  return {
    nextIndex: index,
    value,
  };
}

function readPowerShellDoubleQuotedSegment(stageText: string, startIndex: number) {
  let index = startIndex + 1;
  let value = "";

  while (index < stageText.length) {
    const character = stageText[index];
    const nextCharacter = stageText[index + 1] ?? "";

    if (character === "`") {
      value += nextCharacter;
      index += 2;
      continue;
    }

    if (character === "\"") {
      index += 1;
      break;
    }

    value += character;
    index += 1;
  }

  return {
    nextIndex: index,
    value,
  };
}

function readPowerShellScriptBlock(stageText: string, startIndex: number) {
  let braceDepth = 0;
  let index = startIndex;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let value = "";

  while (index < stageText.length) {
    const character = stageText[index];
    const nextCharacter = stageText[index + 1] ?? "";
    value += character;

    if (inSingleQuote) {
      if (character === "'" && nextCharacter === "'") {
        value += nextCharacter;
        index += 2;
        continue;
      }

      if (character === "'") {
        inSingleQuote = false;
      }

      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (character === "`") {
        value += nextCharacter;
        index += 2;
        continue;
      }

      if (character === "\"") {
        inDoubleQuote = false;
      }

      index += 1;
      continue;
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

    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        index += 1;
        break;
      }
    }

    index += 1;
  }

  return {
    nextIndex: index,
    value,
  };
}

function matchesPowerShellCommand(parsedStage: ParsedPowerShellStage, names: string[]) {
  return parsedStage.commandName !== null && names.includes(parsedStage.commandName);
}

function hasPowerShellFlag(parsedStage: ParsedPowerShellStage, flag: string) {
  return parsedStage.tokens.some((token) => token.toLowerCase() === flag.toLowerCase());
}

function readPowerShellNamedValue(parsedStage: ParsedPowerShellStage, flags: string[]) {
  const normalizedFlags = flags.map((flag) => flag.toLowerCase());

  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    const normalizedToken = token.toLowerCase();

    if (normalizedFlags.includes(normalizedToken)) {
      const nextToken = parsedStage.tokens[index + 1];
      if (nextToken && !nextToken.startsWith("-")) {
        return nextToken;
      }

      continue;
    }

    for (const flag of normalizedFlags) {
      if (!normalizedToken.startsWith(`${flag}:`)) {
        continue;
      }

      return token.slice(flag.length + 1);
    }
  }

  return null;
}

function readPowerShellNumericValue(parsedStage: ParsedPowerShellStage, flag: string) {
  const value = readPowerShellNamedValue(parsedStage, [flag]);
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  return Number(value);
}

function getPowerShellPositionalArguments(parsedStage: ParsedPowerShellStage) {
  const argumentsList: string[] = [];

  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    if (!token.startsWith("-")) {
      argumentsList.push(token);
      continue;
    }

    const nextToken = parsedStage.tokens[index + 1];
    if (nextToken && !nextToken.startsWith("-")) {
      index += 1;
    }
  }

  return argumentsList;
}

function getPowerShellStagePathPart(parsedStage: ParsedPowerShellStage, context: Parameters<typeof buildCommandPathPart>[1]) {
  const path = readPowerShellNamedValue(parsedStage, ["-LiteralPath", "-Path"]) ?? getPowerShellPositionalArguments(parsedStage)[0];
  return path ? buildCommandPathPart(path, context) : null;
}

function buildPowerShellSelectObjectReadSummary(
  context: Parameters<CommandMatcherDefinition["match"]>[0],
  pathPart: NonNullable<ReturnType<typeof getPowerShellStagePathPart>>,
) {
  if (!context.stage.remainingCommand) {
    return null;
  }

  const nextStage = consumeNextCommandStage(context.stage.remainingCommand, "powershell");
  if (!nextStage) {
    return null;
  }

  const parsedNextStage = parsePowerShellStage(nextStage.text);
  if (!matchesPowerShellCommand(parsedNextStage, ["select-object", "select"])) {
    return null;
  }

  const skip = readPowerShellNumericValue(parsedNextStage, "-Skip");
  const first = readPowerShellNumericValue(parsedNextStage, "-First");
  const last = readPowerShellNumericValue(parsedNextStage, "-Last");

  if (skip !== null && first !== null) {
    const nextPathPart = CommandMatcher.Path({
      ...pathPart,
      lineNumber: first === 1 ? skip + 1 : null,
    });

    return CommandMatcher.Result({
      remainingCommand: nextStage.remainingCommand,
      summaryParts: first === 1
        ? [
          CommandMatcher.Text("Read "),
          nextPathPart,
        ]
        : [
          CommandMatcher.Text(`Read lines ${skip + 1}-${skip + first} of `),
          pathPart,
        ],
    });
  }

  if (first !== null) {
    return CommandMatcher.Result({
      remainingCommand: nextStage.remainingCommand,
      summaryParts: [
        CommandMatcher.Text(`Read first ${first} lines of `),
        pathPart,
      ],
    });
  }

  if (last !== null) {
    return CommandMatcher.Result({
      remainingCommand: nextStage.remainingCommand,
      summaryParts: [
        CommandMatcher.Text(`Read last ${last} lines of `),
        pathPart,
      ],
    });
  }

  if (skip !== null) {
    return CommandMatcher.Result({
      remainingCommand: nextStage.remainingCommand,
      summaryParts: [
        CommandMatcher.Text(`Read from line ${skip + 1} of `),
        pathPart,
      ],
    });
  }

  return null;
}

function splitPowerShellList(value: string | null) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function summarizeWhereObjectExclusion(parsedStage: ParsedPowerShellStage) {
  const scriptBlock = parsedStage.tokens.slice(1).join(" ").trim();
  if (!scriptBlock) {
    return null;
  }

  const normalizedScript = scriptBlock
    .replace(/^\{\s*/, "")
    .replace(/\s*\}$/, "")
    .trim();
  const rawMatch = normalizedScript.match(/\$_(?:\.[A-Za-z_][\w]*)*\s+-notmatch\s+([\s\S]+)$/i);
  if (!rawMatch?.[1]) {
    return null;
  }

  const rawExpression = rawMatch[1].trim();
  const quotedCandidates = readPowerShellQuotedFragments(rawExpression)
    .map((fragment) => formatExclusionPattern(fragment))
    .filter((fragment) => /[A-Za-z0-9]/.test(fragment));
  if (quotedCandidates.length) {
    return quotedCandidates[quotedCandidates.length - 1] ?? null;
  }

  const formattedExpression = formatExclusionPattern(rawExpression);
  return /[A-Za-z0-9]/.test(formattedExpression)
    ? formattedExpression
    : null;
}

function formatExclusionPattern(pattern: string) {
  const simplifiedPattern = formatPatternForDisplay(pattern)
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!simplifiedPattern) {
    return "";
  }

  const segmentMatches = Array.from(
    simplifiedPattern.matchAll(/(?:^|\/)(\.?[A-Za-z0-9._-]+)(?=\/|$)/g),
    (match) => match[1],
  ).filter(Boolean);

  return segmentMatches[segmentMatches.length - 1] ?? simplifiedPattern;
}

function formatPatternForDisplay(pattern: string) {
  return pattern
    .replace(/\\\\/g, "\\")
    .replace(/\\([()[\]{}.+*?^$|])/g, "$1");
}

function readPowerShellQuotedFragments(value: string) {
  const fragments: string[] = [];
  let index = 0;

  while (index < value.length) {
    const character = value[index];

    if (character === "'") {
      const segment = readPowerShellSingleQuotedSegment(value, index);
      fragments.push(segment.value);
      index = segment.nextIndex;
      continue;
    }

    if (character === "\"") {
      const segment = readPowerShellDoubleQuotedSegment(value, index);
      fragments.push(segment.value);
      index = segment.nextIndex;
      continue;
    }

    index += 1;
  }

  return fragments;
}
