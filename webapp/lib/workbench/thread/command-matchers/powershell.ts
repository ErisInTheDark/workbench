/*
 * Exports:
 * - POWERSHELL_COMMAND_MATCHERS: PowerShell stage matchers for probes, reads, listings, filters, searches, deletes, and web requests. Keywords: thread, command, matcher, powershell, delete, web, request.
 */

import {
  buildCommandPathPart,
  buildDisplayPathPart,
  buildReadCommandSummary,
  getCommandPathKnownSkill,
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
    id: "powershell.hide-thread-title-setting",
    match: (context) => {
      if (context.summaryParts.length || !isPowerShellThreadTitleSettingCommand(context.unwrappedCommand)) {
        return null;
      }

      return CommandMatcher.Result({
        hide: true,
        omitFromDisplay: true,
        remainingCommand: null,
        summaryParts: [],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.delete-resolved-folder",
    match: (context) => {
      if (context.summaryParts.length) {
        return null;
      }

      const deletePath = readPowerShellResolvedRemoveItemPath(context.unwrappedCommand);
      if (!deletePath) {
        return null;
      }

      const pathPart = buildCommandPathPart(deletePath, context);
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [
          CommandMatcher.Text("Delete folder "),
          pathPart,
        ],
        summaryStats: { deletedPaths: 1 },
      });
    },
  }),
  CommandMatcher({
    id: "powershell.delete-folder",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["remove-item", "rm", "del", "erase", "rmdir", "rd", "ri"])) {
        return null;
      }

      if (!hasPowerShellTruthyFlag(parsedStage, "-Recurse", ["-r"])) {
        return null;
      }

      const path = getPowerShellStagePath(parsedStage);
      if (!path || path.startsWith("$")) {
        return null;
      }

      const pathPart = buildCommandPathPart(path, context);
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text("Delete folder "),
          pathPart,
        ],
        summaryStats: { deletedPaths: 1 },
      });
    },
  }),
  CommandMatcher({
    id: "powershell.read-numbered-lines",
    match: (context) => {
      const assignedRead = readPowerShellAssignedReadStage(context.stage.text, context);
      if (!assignedRead || !context.stage.remainingCommand) {
        return null;
      }

      const nextStage = consumeNextCommandStage(context.stage.remainingCommand, "powershell");
      if (!nextStage) {
        return null;
      }

      const lineRange = readPowerShellNumberedLineRange(nextStage.text, assignedRead.variableName);
      if (!lineRange) {
        return null;
      }

      return buildPowerShellLineRangeReadSummary(
        assignedRead.pathPart,
        lineRange.startLine,
        lineRange.endLine,
        context,
        nextStage.remainingCommand,
      );
    },
  }),
  CommandMatcher({
    id: "powershell.hide-trivial-assignment",
    match: (context) => {
      if (!isPowerShellTrivialAssignmentStage(context.stage.text)) {
        return null;
      }

      return CommandMatcher.Result({
        hide: true,
        summaryParts: [],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.check-path",
    match: (context) => {
      const pathPart = buildPowerShellTestPathPart(context.stage.text, context);
      if (!pathPart) {
        return null;
      }

      return CommandMatcher.Result({
        summaryParts: [
          CommandMatcher.Text("Checked for "),
          pathPart,
        ],
        summaryStats: { pathChecks: 1 },
      });
    },
  }),
  CommandMatcher({
    id: "powershell.web-request",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["invoke-restmethod", "irm", "invoke-webrequest", "iwr", "curl", "wget"])) {
        return null;
      }

      const requestUrl = readPowerShellNamedValue(parsedStage, ["-Uri", "-Url"])
        ?? getPowerShellPositionalArguments(parsedStage)[0];
      const urlDisplay = formatWebRequestUrl(requestUrl);
      if (!urlDisplay) {
        return null;
      }

      const method = (readPowerShellNamedValue(parsedStage, ["-Method"]) ?? "GET").toUpperCase();
      const bodySummary = readPowerShellWebRequestBodySummary(parsedStage, context.unwrappedCommand);
      const summaryParts = [
        CommandMatcher.Text(`${method} `),
        CommandMatcher.Code(urlDisplay),
      ];

      if (bodySummary) {
        summaryParts.push(CommandMatcher.Text(" with JSON "));
        summaryParts.push(CommandMatcher.Code(bodySummary));
      }

      return CommandMatcher.Result({
        remainingCommand: shouldHidePowerShellWebRequestRemainder(context.stage.remainingCommand)
          ? null
          : context.stage.remainingCommand,
        summaryParts,
        summaryStats: { webRequests: 1 },
      });
    },
  }),
  CommandMatcher({
    id: "powershell.read",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["get-content", "gc"])) {
        return null;
      }

      const path = getPowerShellStagePath(parsedStage);
      const pathPart = path ? buildCommandPathPart(path, context) : null;
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
        const readSummary = buildReadCommandSummary(path, context);
        if (readSummary?.summaryStats.skillLoads) {
          return CommandMatcher.Result({
            summaryStats: readSummary.summaryStats,
            summaryParts: readSummary.summaryParts,
          });
        }

        return buildPowerShellLineRangeReadSummary(pathPart, skip + 1, skip + first, context);
      }

      if (first !== null) {
        const readSummary = buildReadCommandSummary(path, context, `Read first ${first} lines of `);
        if (!readSummary) {
          return null;
        }

        return CommandMatcher.Result({
          summaryStats: readSummary.summaryStats,
          summaryParts: readSummary.summaryParts,
        });
      }

      if (totalCount !== null) {
        const readSummary = buildReadCommandSummary(path, context, `Read first ${totalCount} lines of `);
        if (!readSummary) {
          return null;
        }

        return CommandMatcher.Result({
          summaryStats: readSummary.summaryStats,
          summaryParts: readSummary.summaryParts,
        });
      }

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
          summaryStats: { listedFiles: 1 },
          summaryParts: [
            CommandMatcher.Text("List "),
            CommandMatcher.Code(includePatterns.join(", ")),
            CommandMatcher.Text(` ${collectionLabel} ${locationLabel} `),
            pathPart,
          ],
        });
      }

      return CommandMatcher.Result({
        summaryStats: { listedFiles: 1 },
        summaryParts: [
          CommandMatcher.Text(`List ${collectionLabel} ${locationLabel} `),
          pathPart,
        ],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.list-rg-files",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesRipgrepCommand(parsedStage) || !hasPowerShellFlag(parsedStage, "--files")) {
        return null;
      }

      const positionalArguments = getPowerShellPositionalArguments(parsedStage);
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
    id: "powershell.search-rg",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (matchesRipgrepCommand(parsedStage) === false || hasPowerShellFlag(parsedStage, "--files")) {
        return null;
      }

      const positionalArguments = getPowerShellPositionalArguments(parsedStage);
      const query = readPowerShellNamedValue(parsedStage, ["-e", "--regexp"]) ?? positionalArguments[0];
      if (!query) {
        return null;
      }

      const summaryParts = [
        CommandMatcher.Text("Search for "),
        CommandMatcher.Code(`"${formatPatternForDisplay(query)}"`),
      ];
      const path = getPowerShellRipgrepPathArgument(parsedStage, positionalArguments);
      const pathPart = path
        ? buildCommandPathPart(path, context)
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
  CommandMatcher({
    id: "powershell.exclude",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["where-object", "?"])) {
        return null;
      }

      const whereObjectFilter = summarizeWhereObjectFilter(parsedStage);
      if (!whereObjectFilter) {
        return null;
      }

      return CommandMatcher.Result({
        summaryStats: { otherCommands: 1 },
        summaryParts: whereObjectFilter.mode === "exclude"
          ? [
            CommandMatcher.Text("Exclude "),
            CommandMatcher.Code(whereObjectFilter.pattern),
          ]
          : [
            CommandMatcher.Text("Filter to "),
            CommandMatcher.Code(whereObjectFilter.pattern),
          ],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.hide-select-object",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["select-object", "select"])) {
        return null;
      }

      return CommandMatcher.Result({
        hide: true,
        summaryParts: [],
      });
    },
  }),
  CommandMatcher({
    id: "powershell.hide-foreach-formatting",
    match: (context) => {
      const parsedStage = parsePowerShellStage(context.stage.text);
      if (!matchesPowerShellCommand(parsedStage, ["foreach-object", "%"])) {
        return null;
      }

      if (!shouldHidePowerShellForEachFormattingStage(parsedStage)) {
        return null;
      }

      return CommandMatcher.Result({
        hide: true,
        summaryParts: [],
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

      return CommandMatcher.Result({
        summaryParts,
        summaryStats: { searchedFiles: 1 },
      });
    },
  }),
];

function parsePowerShellStage(stageText: string): ParsedPowerShellStage {
  const tokens = tokenizePowerShell(unwrapPowerShellStageText(stageText));
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
  const normalizedCommandName = normalizePowerShellCommandName(parsedStage.commandName);
  return normalizedCommandName !== null && names.includes(normalizedCommandName);
}

function matchesRipgrepCommand(parsedStage: ParsedPowerShellStage) {
  const normalizedCommandName = normalizePowerShellCommandName(parsedStage.commandName);
  return normalizedCommandName === "rg" || normalizedCommandName === "rg.exe";
}

function hasPowerShellFlag(parsedStage: ParsedPowerShellStage, flag: string) {
  return parsedStage.tokens.some((token) => token.toLowerCase() === flag.toLowerCase());
}

function hasPowerShellTruthyFlag(parsedStage: ParsedPowerShellStage, flag: string, aliases: string[] = []) {
  const normalizedFlags = [flag, ...aliases].map((entry) => entry.toLowerCase());
  return parsedStage.tokens.some((token) => {
    const normalizedToken = token.toLowerCase();
    if (normalizedFlags.includes(normalizedToken)) {
      return true;
    }

    const matchedFlag = normalizedFlags.find((candidate) => normalizedToken.startsWith(`${candidate}:`));
    if (!matchedFlag) {
      return false;
    }

    const flagValue = normalizedToken.slice(matchedFlag.length + 1).trim();
    return flagValue !== "$false" && flagValue !== "false" && flagValue !== "0";
  });
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
  const consumingFlags = getPowerShellValueFlags(parsedStage.commandName);

  for (let index = 1; index < parsedStage.tokens.length; index += 1) {
    const token = parsedStage.tokens[index];
    if (!token.startsWith("-")) {
      argumentsList.push(token);
      continue;
    }

    if (token.includes(":")) {
      continue;
    }

    const nextToken = parsedStage.tokens[index + 1];
    if (consumingFlags.has(token.toLowerCase()) && nextToken && !nextToken.startsWith("-")) {
      index += 1;
    }
  }

  return argumentsList;
}

function getPowerShellStagePath(parsedStage: ParsedPowerShellStage) {
  return readPowerShellNamedValue(parsedStage, ["-LiteralPath", "-Path"]) ?? getPowerShellPositionalPathArgument(parsedStage);
}

function readPowerShellResolvedRemoveItemPath(commandText: string) {
  const normalizedCommandText = unwrapPowerShellStageText(commandText);
  const resolvedPathsByVariable = readPowerShellResolvePathAssignments(normalizedCommandText);
  if (!resolvedPathsByVariable.size) {
    return null;
  }

  const removeItemMatch = normalizedCommandText.match(/\bRemove-Item\b([\s\S]*?)(?=(?:[\r\n;}]|\belse\b|$))/i);
  if (!removeItemMatch) {
    return null;
  }

  const parsedRemoveItem = parsePowerShellStage(`Remove-Item ${removeItemMatch[1] ?? ""}`);
  if (!matchesPowerShellCommand(parsedRemoveItem, ["remove-item"]) || !hasPowerShellTruthyFlag(parsedRemoveItem, "-Recurse", ["-r"])) {
    return null;
  }

  const path = getPowerShellStagePath(parsedRemoveItem);
  if (!path) {
    return null;
  }

  const variablePathMatch = path.match(/^\$([A-Za-z_][\w]*)(?:\.Path)?$/);
  if (!variablePathMatch?.[1]) {
    return path.startsWith("$") ? null : path;
  }

  return resolvedPathsByVariable.get(variablePathMatch[1].toLowerCase()) ?? null;
}

function readPowerShellResolvePathAssignments(commandText: string) {
  const assignments = new Map<string, string>();
  const assignmentPattern = /\$([A-Za-z_][\w]*)\s*=\s*(Resolve-Path\b[\s\S]*?)(?=(?:[\r\n;]+|\s+\$[A-Za-z_][\w]*\s*=|\s+if\s*\(|$))/gi;
  let match: RegExpExecArray | null;

  while ((match = assignmentPattern.exec(commandText)) !== null) {
    const variableName = match[1];
    const resolvePathCommand = match[2];
    if (!variableName || !resolvePathCommand) {
      continue;
    }

    const parsedResolvePath = parsePowerShellStage(resolvePathCommand);
    if (!matchesPowerShellCommand(parsedResolvePath, ["resolve-path"])) {
      continue;
    }

    const path = getPowerShellStagePath(parsedResolvePath);
    if (!path || path.startsWith("$")) {
      continue;
    }

    assignments.set(variableName.toLowerCase(), path);
  }

  return assignments;
}

function getPowerShellStagePathPart(parsedStage: ParsedPowerShellStage, context: Parameters<typeof buildCommandPathPart>[1]) {
  const path = getPowerShellStagePath(parsedStage);
  return path ? buildCommandPathPart(path, context) : null;
}

function readPowerShellAssignedReadStage(
  stageText: string,
  context: Parameters<typeof buildCommandPathPart>[1],
) {
  const assignmentMatch = unwrapPowerShellStageText(stageText).match(/^\$([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/);
  if (!assignmentMatch?.[1] || !assignmentMatch[2]) {
    return null;
  }

  const parsedAssignedStage = parsePowerShellStage(assignmentMatch[2]);
  if (!matchesPowerShellCommand(parsedAssignedStage, ["get-content", "gc"])) {
    return null;
  }

  const pathPart = getPowerShellStagePathPart(parsedAssignedStage, context);
  if (!pathPart) {
    return null;
  }

  return {
    pathPart,
    variableName: assignmentMatch[1],
  };
}

function readPowerShellNumberedLineRange(stageText: string, variableName: string) {
  const normalizedStageText = unwrapPowerShellStageText(stageText);
  const directRange = readPowerShellVariableLineRange(normalizedStageText, variableName);
  if (directRange) {
    return directRange;
  }

  const loopMatch = normalizedStageText.match(
    /^for\s*\(\s*\$([A-Za-z_][\w]*)\s*=\s*(\d+)\s*;\s*\$\1\s*-le\s*(\d+)\s*;\s*\$\1\s*\+\+\s*\)\s*\{([\s\S]+)\}$/i,
  );
  if (!loopMatch?.[1] || !loopMatch[2] || !loopMatch[3] || !loopMatch[4]) {
    return null;
  }

  const indexVariableName = loopMatch[1];
  const startIndex = Number(loopMatch[2]);
  const endIndex = Number(loopMatch[3]);
  const body = loopMatch[4];
  if (
    !Number.isFinite(startIndex)
    || !Number.isFinite(endIndex)
    || endIndex < startIndex
    || !new RegExp(`\\$${escapeRegExp(variableName)}\\s*\\[\\s*\\$${escapeRegExp(indexVariableName)}\\s*\\]`, "i").test(body)
  ) {
    return null;
  }

  const usesOneBasedDisplay = new RegExp(`\\$${escapeRegExp(indexVariableName)}\\s*\\+\\s*1`, "i").test(body);
  const lineOffset = usesOneBasedDisplay ? 1 : 0;
  return {
    endLine: endIndex + lineOffset,
    startLine: startIndex + lineOffset,
  };
}

function readPowerShellVariableLineRange(stageText: string, variableName: string) {
  const variablePattern = escapeRegExp(variableName);
  const rangeMatch = stageText.match(
    new RegExp(`^\\$${variablePattern}\\s*\\[\\s*(\\d+)\\s*\\.\\.\\s*(\\d+)\\s*\\]\\s*$`, "i"),
  );
  if (!rangeMatch?.[1] || !rangeMatch[2]) {
    return null;
  }

  const startIndex = Number(rangeMatch[1]);
  const endIndex = Number(rangeMatch[2]);
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex) || endIndex < startIndex) {
    return null;
  }

  return {
    endLine: endIndex + 1,
    startLine: startIndex + 1,
  };
}

function buildPowerShellSelectObjectReadSummary(
  context: Parameters<CommandMatcherDefinition["match"]>[0],
  pathPart: NonNullable<ReturnType<typeof getPowerShellStagePathPart>>,
) {
  let remainingCommand = context.stage.remainingCommand;

  while (remainingCommand) {
    const nextStage = consumeNextCommandStage(remainingCommand, "powershell");
    if (!nextStage) {
      return null;
    }

    const parsedNextStage = parsePowerShellStage(nextStage.text);
    if (!matchesPowerShellCommand(parsedNextStage, ["select-object", "select"])) {
      if (matchesPowerShellCommand(parsedNextStage, ["foreach-object", "%"])) {
        const lineRange = readPowerShellForEachNumberedLineRange(parsedNextStage);
        if (lineRange) {
          return buildPowerShellLineRangeReadSummary(
            pathPart,
            lineRange.startLine,
            lineRange.endLine,
            context,
            nextStage.remainingCommand,
          );
        }

        if (shouldHidePowerShellForEachFormattingStage(parsedNextStage)) {
          remainingCommand = nextStage.remainingCommand ?? null;
          continue;
        }
      }

      return null;
    }

    const skip = readPowerShellNumericValue(parsedNextStage, "-Skip");
    const first = readPowerShellNumericValue(parsedNextStage, "-First");
    const last = readPowerShellNumericValue(parsedNextStage, "-Last");

    if (skip !== null && first !== null) {
      return buildPowerShellLineRangeReadSummary(pathPart, skip + 1, skip + first, context, nextStage.remainingCommand);
    }

    if (first !== null) {
      const skillLoadSummary = buildPowerShellSkillLoadSummaryFromPathPart(pathPart, context, nextStage.remainingCommand);
      if (skillLoadSummary) {
        return skillLoadSummary;
      }

      return CommandMatcher.Result({
        remainingCommand: nextStage.remainingCommand,
        summaryStats: { readFiles: 1 },
        summaryParts: [
          CommandMatcher.Text(`Read first ${first} lines of `),
          pathPart,
        ],
      });
    }

    if (last !== null) {
      const skillLoadSummary = buildPowerShellSkillLoadSummaryFromPathPart(pathPart, context, nextStage.remainingCommand);
      if (skillLoadSummary) {
        return skillLoadSummary;
      }

      return CommandMatcher.Result({
        remainingCommand: nextStage.remainingCommand,
        summaryStats: { readFiles: 1 },
        summaryParts: [
          CommandMatcher.Text(`Read last ${last} lines of `),
          pathPart,
        ],
      });
    }

    if (skip !== null) {
      const skillLoadSummary = buildPowerShellSkillLoadSummaryFromPathPart(pathPart, context, nextStage.remainingCommand);
      if (skillLoadSummary) {
        return skillLoadSummary;
      }

      return CommandMatcher.Result({
        remainingCommand: nextStage.remainingCommand,
        summaryStats: { readFiles: 1 },
        summaryParts: [
          CommandMatcher.Text(`Read from line ${skip + 1} of `),
          pathPart,
        ],
      });
    }

    return null;
  }

  return null;
}

function buildPowerShellLineRangeReadSummary(
  pathPart: NonNullable<ReturnType<typeof getPowerShellStagePathPart>>,
  startLine: number,
  endLine: number,
  context: Parameters<CommandMatcherDefinition["match"]>[0],
  remainingCommand?: string | null,
) {
  const skillLoadSummary = buildPowerShellSkillLoadSummaryFromPathPart(pathPart, context, remainingCommand);
  if (skillLoadSummary) {
    return skillLoadSummary;
  }

  if (startLine === endLine) {
    return CommandMatcher.Result({
      remainingCommand,
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
    remainingCommand,
    summaryStats: { readFiles: 1 },
    summaryParts: [
      CommandMatcher.Text(`Read lines ${startLine}-${endLine} of `),
      pathPart,
    ],
  });
}

function buildPowerShellSkillLoadSummaryFromPathPart(
  pathPart: NonNullable<ReturnType<typeof getPowerShellStagePathPart>>,
  context: Parameters<CommandMatcherDefinition["match"]>[0],
  remainingCommand?: string | null,
) {
  const knownSkill = getCommandPathKnownSkill(pathPart.path, context);
  if (knownSkill) {
    return CommandMatcher.Result({
      remainingCommand,
      summaryStats: { skillLoads: 1 },
      summaryParts: [
        CommandMatcher.Text("Load "),
        CommandMatcher.Skill({ name: knownSkill.name, path: knownSkill.path }),
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

function summarizeWhereObjectFilter(parsedStage: ParsedPowerShellStage) {
  const normalizedScript = getNormalizedPowerShellScriptBlock(parsedStage);
  if (!normalizedScript) {
    return null;
  }

  const rawMatch = normalizedScript.match(/\$_(?:\.[A-Za-z_][\w]*)*\s+-(notmatch|match)\s+([\s\S]+)$/i);
  if (!rawMatch?.[1] || !rawMatch[2]) {
    return null;
  }

  const mode = rawMatch[1].toLowerCase() === "notmatch" ? "exclude" : "include";
  const rawExpression = rawMatch[2].trim();
  const quotedCandidates = readPowerShellQuotedFragments(rawExpression)
    .map((fragment) => formatWhereObjectPattern(fragment, mode))
    .filter((fragment) => /[A-Za-z0-9]/.test(fragment));
  const pattern = quotedCandidates.length
    ? quotedCandidates[quotedCandidates.length - 1] ?? null
    : formatWhereObjectPattern(rawExpression, mode);
  if (!pattern || !/[A-Za-z0-9]/.test(pattern)) {
    return null;
  }

  return {
    mode,
    pattern,
  } as const;
}

function formatWhereObjectPattern(pattern: string, mode: "exclude" | "include") {
  if (mode === "exclude") {
    return formatExclusionPattern(pattern);
  }

  return formatPatternForDisplay(pattern)
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
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

function getNormalizedPowerShellScriptBlock(parsedStage: ParsedPowerShellStage) {
  const scriptBlock = parsedStage.tokens.slice(1).join(" ").trim();
  if (!scriptBlock) {
    return null;
  }

  return scriptBlock
    .replace(/^\{\s*/, "")
    .replace(/\s*\}$/, "")
    .trim();
}

function shouldHidePowerShellForEachFormattingStage(parsedStage: ParsedPowerShellStage) {
  const normalizedScript = getNormalizedPowerShellScriptBlock(parsedStage);
  if (!normalizedScript) {
    return false;
  }

  if (isPowerShellLineNumberFormattingScript(normalizedScript)) {
    return true;
  }

  if (/[|;]/.test(normalizedScript)) {
    return false;
  }

  if (/\b(?:if|foreach|switch|try|catch|throw|return)\b/i.test(normalizedScript)) {
    return false;
  }

  if (!/\$_\.(?:Context|Filename|FullName|Line|LineNumber|Path)\b/i.test(normalizedScript)) {
    return false;
  }

  return !/\b(?:Write-|Out-|Format-|Get-|Set-|Select-|Where-|ForEach-|Sort-|Measure-)[A-Za-z]+\b/i.test(normalizedScript);
}

function formatWebRequestUrl(value: string | null) {
  const url = String(value ?? "").trim();
  if (!url || url.startsWith("$")) {
    return null;
  }

  const protocolMatch = url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.+)$/);
  if (protocolMatch?.[1]) {
    return protocolMatch[1].replace(/\/$/, "") || null;
  }

  return url.replace(/\/$/, "") || null;
}

function readPowerShellWebRequestBodySummary(parsedStage: ParsedPowerShellStage, commandText: string) {
  const bodyValue = readPowerShellNamedValue(parsedStage, ["-Body"]);
  if (!bodyValue) {
    return null;
  }

  const resolvedBody = bodyValue.startsWith("$")
    ? readPowerShellAssignedJsonBody(commandText, bodyValue.slice(1))
    : bodyValue;
  if (!resolvedBody) {
    return null;
  }

  return formatJsonBodyForDisplay(resolvedBody);
}

function readPowerShellAssignedJsonBody(commandText: string, variableName: string) {
  const variablePattern = escapeRegExp(variableName);
  const assignmentMatch = unwrapPowerShellStageText(commandText).match(
    new RegExp(`\\$${variablePattern}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"),
  );

  return assignmentMatch?.[2] ?? null;
}

function formatJsonBodyForDisplay(value: string) {
  const normalizedValue = value
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();
  if (!normalizedValue) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(normalizedValue));
  } catch {
    if (/^[\[{]/.test(normalizedValue)) {
      return normalizedValue.replace(/\s+/g, " ");
    }
  }

  return null;
}

function shouldHidePowerShellWebRequestRemainder(remainingCommand: string | null) {
  let nextCommand = remainingCommand;

  while (nextCommand) {
    const nextStage = consumeNextCommandStage(nextCommand, "powershell");
    if (!nextStage) {
      return false;
    }

    const parsedStage = parsePowerShellStage(nextStage.text);
    if (
      !matchesPowerShellCommand(parsedStage, ["convertto-json", "out-null"])
      && !isPowerShellTrivialAssignmentStage(nextStage.text)
    ) {
      return false;
    }

    nextCommand = nextStage.remainingCommand;
  }

  return true;
}

function readPowerShellForEachNumberedLineRange(parsedStage: ParsedPowerShellStage) {
  const normalizedScript = getNormalizedPowerShellScriptBlock(parsedStage);
  if (!normalizedScript) {
    return null;
  }

  const rangeMatch = normalizedScript.match(
    /^\$([A-Za-z_][\w]*)\s*\+\+\s*;\s*if\s*\(\s*\$\1\s*-ge\s*(\d+)\s*-and\s*\$\1\s*-le\s*(\d+)\s*\)\s*\{([\s\S]+)\}\s*$/i,
  );
  if (!rangeMatch?.[2] || !rangeMatch[3] || !rangeMatch[4]) {
    return null;
  }

  const startLine = Number(rangeMatch[2]);
  const endLine = Number(rangeMatch[3]);
  const body = rangeMatch[4].trim();
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine || !body) {
    return null;
  }

  if (!/\$_(?:\b|[^A-Za-z0-9_])/.test(body)) {
    return null;
  }

  return {
    endLine,
    startLine,
  };
}

function isPowerShellTrivialAssignmentStage(stageText: string) {
  const assignmentMatch = unwrapPowerShellStageText(stageText).match(/^\$([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/);
  if (!assignmentMatch?.[2]) {
    return false;
  }

  const assignedValue = assignmentMatch[2].trim();
  if (!assignedValue) {
    return false;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(assignedValue)) {
    return true;
  }

  if (/^\$(?:false|null|true)$/i.test(assignedValue)) {
    return true;
  }

  return unwrapPowerShellQuotedTextOnce(assignedValue) !== null;
}

function buildPowerShellTestPathPart(
  stageText: string,
  context: Parameters<typeof buildCommandPathPart>[1],
) {
  const parsedStage = parsePowerShellStage(stageText);
  if (!matchesPowerShellCommand(parsedStage, ["test-path"])) {
    return null;
  }

  return getPowerShellStagePathPart(parsedStage, context);
}

function isPowerShellThreadTitleSettingCommand(commandText: string) {
  const normalizedCommandText = unwrapPowerShellStageText(commandText)
    .replace(/\r\n/g, "\n")
    .replace(/(?:'")|(?:"')/g, "'")
    .trim();
  const titleSettingMatch = normalizedCommandText.match(
    /^\$title\s*=\s*['"]+[^'\r\n]*(?:''[^'\r\n]*)*['"]+\s*\n+\s*['"]*\$body\s*=\s*@\{\s*harness\s*=\s*['"]+codex'\s*;\s*threadId\s*=\s*'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'\s*;\s*title\s*=\s*['"]*\$title\s*\}\s*\|\s*ConvertTo-Json\s+-Compress\s*\n+\s*Invoke-RestMethod\s+-Method\s+Post\s+-Uri\s*['"]+http:\/\/127\.0\.0\.1:3002\/api\/thread-title'\s+-ContentType\s*'application\/json'\s+-Body\s+['"]*\$body\s*\|\s*Out-Null\s*$/i,
  );

  return Boolean(titleSettingMatch);
}

function isPowerShellLineNumberFormattingScript(scriptText: string) {
  const incrementMatch = scriptText.match(/;\s*['"`]*\$([A-Za-z_][\w]*)\+\+\s*$/i);
  if (!incrementMatch?.[1] || incrementMatch.index === undefined) {
    return false;
  }

  const variableName = incrementMatch[1];
  const formatStatement = scriptText.slice(0, incrementMatch.index).trim();
  if (!formatStatement) {
    return false;
  }

  if (/[|]/.test(formatStatement)) {
    return false;
  }

  if (!/\$_\b/.test(formatStatement) || !/\s-f\s/i.test(formatStatement)) {
    return false;
  }

  if (/\b(?:if|foreach|switch|try|catch|throw|return)\b/i.test(formatStatement)) {
    return false;
  }

  return new RegExp(`['"\`]*\\$${escapeRegExp(variableName)}(?:\\b|\\s|,)`, "i").test(formatStatement);
}

function unwrapPowerShellStageText(stageText: string) {
  let currentText = String(stageText ?? "").trim();

  for (let index = 0; index < 4; index += 1) {
    const unwrappedText = unwrapPowerShellQuotedTextOnce(currentText)
      ?? unwrapPowerShellTestPathIfStageOnce(currentText);
    if (unwrappedText === null || unwrappedText === currentText) {
      break;
    }

    currentText = unwrappedText.trim();
  }

  return currentText;
}

function unwrapPowerShellQuotedTextOnce(value: string) {
  if (value.length < 2) {
    return null;
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    const segment = readPowerShellSingleQuotedSegment(value, 0);
    return segment.nextIndex === value.length ? segment.value : null;
  }

  if (value.startsWith("\"") && value.endsWith("\"")) {
    const segment = readPowerShellDoubleQuotedSegment(value, 0);
    return segment.nextIndex === value.length ? segment.value : null;
  }

  return null;
}

function unwrapPowerShellTestPathIfStageOnce(stageText: string) {
  const normalizedStageText = String(stageText ?? "").trim();
  const ifMatch = normalizedStageText.match(/^if\b/i);
  if (!ifMatch) {
    return null;
  }

  let index = ifMatch[0].length;
  while (index < normalizedStageText.length && /\s/.test(normalizedStageText[index])) {
    index += 1;
  }

  if (normalizedStageText[index] !== "(") {
    return null;
  }

  const condition = readPowerShellParenthesizedExpression(normalizedStageText, index);
  if (!condition || !/\btest-path\b/i.test(condition.value)) {
    return null;
  }

  index = condition.nextIndex;
  while (index < normalizedStageText.length && /\s/.test(normalizedStageText[index])) {
    index += 1;
  }

  if (normalizedStageText[index] !== "{") {
    return null;
  }

  const body = readPowerShellScriptBlock(normalizedStageText, index);
  if (!body.value.trim()) {
    return null;
  }

  const trailingText = normalizedStageText.slice(body.nextIndex).trim();
  if (trailingText) {
    return null;
  }

  return body.value
    .replace(/^\{\s*/, "")
    .replace(/\s*\}$/, "")
    .trim();
}

function readPowerShellParenthesizedExpression(stageText: string, startIndex: number) {
  let depth = 0;
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

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }

    index += 1;
  }

  if (depth !== 0) {
    return null;
  }

  return {
    nextIndex: index,
    value,
  };
}

function getPowerShellPositionalPathArgument(parsedStage: ParsedPowerShellStage) {
  const positionalArguments = getPowerShellPositionalArguments(parsedStage);

  if (matchesPowerShellCommand(parsedStage, ["select-string", "sls"])) {
    return readPowerShellNamedValue(parsedStage, ["-Pattern"])
      ? positionalArguments[0] ?? null
      : positionalArguments[1] ?? null;
  }

  if (matchesRipgrepCommand(parsedStage)) {
    return getPowerShellRipgrepPathArgument(parsedStage, positionalArguments);
  }

  return positionalArguments[0] ?? null;
}

function getPowerShellRipgrepPathArgument(
  parsedStage: ParsedPowerShellStage,
  positionalArguments = getPowerShellPositionalArguments(parsedStage),
) {
  if (hasPowerShellFlag(parsedStage, "--files")) {
    return positionalArguments[0] ?? null;
  }

  return readPowerShellNamedValue(parsedStage, ["-e", "--regexp"])
    ? positionalArguments[0] ?? null
    : positionalArguments[1] ?? null;
}

function getPowerShellValueFlags(commandName: string | null) {
  const normalizedCommandName = normalizePowerShellCommandName(commandName) ?? "";

  switch (normalizedCommandName) {
    case "get-content":
    case "gc":
      return new Set(["-first", "-literalpath", "-path", "-skip", "-totalcount"]);
    case "get-childitem":
    case "dir":
    case "ls":
      return new Set(["-depth", "-exclude", "-filter", "-include", "-literalpath", "-path"]);
    case "select-object":
    case "select":
      return new Set(["-first", "-index", "-last", "-skip"]);
    case "select-string":
    case "sls":
      return new Set(["-exclude", "-include", "-literalpath", "-path", "-pattern"]);
    case "test-path":
      return new Set(["-credential", "-exclude", "-filter", "-include", "-literalpath", "-newerthan", "-olderthan", "-path", "-pathtype"]);
    case "invoke-restmethod":
    case "irm":
    case "invoke-webrequest":
    case "iwr":
    case "curl":
    case "wget":
      return new Set([
        "-body",
        "-contenttype",
        "-headers",
        "-method",
        "-timeoutsec",
        "-uri",
        "-url",
      ]);
    case "rg":
    case "rg.exe":
      return new Set([
        "-A",
        "--after-context",
        "-B",
        "--before-context",
        "-C",
        "--context",
        "-e",
        "--regexp",
        "-f",
        "--file",
        "-g",
        "--glob",
        "--iglob",
        "-j",
        "--threads",
        "-M",
        "--max-columns",
        "-m",
        "--max-count",
        "--max-depth",
        "--max-filesize",
        "--path-separator",
        "--pre",
        "--pre-glob",
        "--replace",
        "--sort",
        "--sortr",
        "-t",
        "--type",
        "-T",
        "--type-not",
      ]);
    default:
      return new Set<string>();
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePowerShellCommandName(commandName: string | null) {
  const trimmedCommandName = String(commandName ?? "").trim();
  if (!trimmedCommandName) {
    return null;
  }

  const unwrappedCommandName = trimWrappingQuotes(trimmedCommandName.replace(/^([&.]\s*)+/, ""));
  const basename = unwrappedCommandName.split(/[\\/]/).at(-1) ?? unwrappedCommandName;
  const normalizedCommandName = trimWrappingQuotes(basename).toLowerCase();
  return normalizedCommandName || null;
}

function trimWrappingQuotes(value: string) {
  return value.replace(/^['"]+|['"]+$/g, "");
}
