/*
 * Exports:
 * - BROWSE_WEB_REQUEST_COMMAND_MATCHERS: command-summary matchers for Workbench Browse API web requests. Keywords: browse, web request, command matcher.
 */
import { CommandMatcher } from "./core";
import { collapseWhitespace } from "./helpers";
import type { CommandMatcherDefinition, ThreadCommandDisplayPart } from "./types";

interface BrowseRequestSummary {
  action: string;
  session: string | null;
  target: string | null;
}

const BROWSE_ROUTE_PATTERN = /https?:\/\/127\.0\.0\.1:3002\/api\/browse\b|https?:\/\/localhost:3002\/api\/browse\b|['"`]\/api\/browse['"`]/i;

export const BROWSE_WEB_REQUEST_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "browse.web-request",
    match: (context) => {
      if (context.summaryParts.length || !BROWSE_ROUTE_PATTERN.test(context.unwrappedCommand)) {
        return null;
      }

      const summary = readBrowseRequestSummary(context.unwrappedCommand);
      if (!summary) {
        return null;
      }

      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: buildBrowseRequestSummaryParts(summary),
        summaryStats: { webRequests: 1 },
      });
    },
  }),
];

function buildBrowseRequestSummaryParts(summary: BrowseRequestSummary): ThreadCommandDisplayPart[] {
  const parts: ThreadCommandDisplayPart[] = [
    CommandMatcher.Text(`Browse: ${formatBrowseAction(summary.action)}`),
  ];

  if (summary.target) {
    parts.push(CommandMatcher.Text(" "));
    parts.push(CommandMatcher.Code(summary.target));
  }

  if (summary.session) {
    parts.push(CommandMatcher.Text(" in session "));
    parts.push(CommandMatcher.Code(summary.session));
  }

  return parts;
}

function readBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const jsonSummary = readJsonBrowseRequestSummary(commandText);
  if (jsonSummary) {
    return jsonSummary;
  }

  const hashtableSummary = readPowerShellHashtableBrowseRequestSummary(commandText);
  if (hashtableSummary) {
    return hashtableSummary;
  }

  const argsSummary = readPowerShellArgsBrowseRequestSummary(commandText);
  if (argsSummary) {
    return argsSummary;
  }

  return { action: "request", session: null, target: null };
}

function readJsonBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const jsonText = readJsonBodyText(commandText);
  if (!jsonText) {
    return null;
  }

  const parsed = parseJsonBrowseBody(jsonText);
  if (!parsed) {
    return null;
  }

  if (parsed.action) {
    return {
      action: parsed.action,
      session: parsed.session ?? null,
      target: parsed.url
        ?? parsed.selector
        ?? parsed.key
        ?? parsed.what
        ?? parsed.check
        ?? parsed.expression
        ?? parsed.argument
        ?? formatSessionList(parsed.sessions),
    };
  }

  return summarizeBrowseArgs(parsed.args);
}

function readPowerShellHashtableBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const action = readPowerShellHashtableField(commandText, "action", commandText);
  if (!action) {
    return null;
  }

  return {
    action,
    session: readPowerShellHashtableField(commandText, "session", commandText),
    target: readPowerShellHashtableField(commandText, "url", commandText)
      ?? readPowerShellHashtableField(commandText, "selector", commandText)
      ?? readPowerShellHashtableField(commandText, "key", commandText)
      ?? readPowerShellHashtableField(commandText, "what", commandText)
      ?? readPowerShellHashtableField(commandText, "check", commandText)
      ?? readPowerShellHashtableField(commandText, "expression", commandText)
      ?? readPowerShellHashtableField(commandText, "argument", commandText)
      ?? readPowerShellHashtableArrayField(commandText, "sessions", commandText),
  };
}

function readPowerShellArgsBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const argsMatch = commandText.match(/\bargs\s*=\s*@\(([\s\S]*?)\)/i);
  const argsText = argsMatch?.[1];
  if (!argsText) {
    return null;
  }

  const args = [...argsText.matchAll(/(['"`])([^'"`]*?)\1/g)].map((match) => match[2] ?? "");
  return summarizeBrowseArgs(args);
}

function summarizeBrowseArgs(args: string[] | null | undefined): BrowseRequestSummary | null {
  const normalizedArgs = args?.map((arg) => String(arg ?? "").trim()).filter(Boolean) ?? [];
  const action = normalizedArgs[0];
  if (!action) {
    return null;
  }

  return {
    action,
    session: readBrowseArgValue(normalizedArgs, "--session") ?? readBrowseArgValue(normalizedArgs, "-s"),
    target: getBrowseArgsTarget(normalizedArgs),
  };
}

function getBrowseArgsTarget(args: string[]) {
  switch (args[0]) {
    case "open":
      return args[1] ?? null;
    case "click":
    case "fill":
    case "select":
    case "highlight":
    case "wait":
      return args[1] ?? null;
    case "get":
    case "is":
      return args[2] ?? args[1] ?? null;
    case "eval":
      return args[1] ?? null;
    case "key":
    case "press":
    case "type":
      return args[1] ?? null;
    default:
      return null;
  }
}

function readBrowseArgValue(args: string[], flag: string) {
  const index = args.findIndex((arg) => arg.toLowerCase() === flag.toLowerCase());
  if (index < 0) {
    return null;
  }

  return args[index + 1] ?? null;
}

function readJsonBodyText(commandText: string) {
  const bodyMatch = commandText.match(/(?:-Body|-d|--data|--data-raw)\s+(['"])([\s\S]*?)\1/i);
  const bodyText = bodyMatch?.[2];
  if (!bodyText || !/^\s*\{/.test(bodyText)) {
    return null;
  }

  return bodyText
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();
}

function readPowerShellHashtableField(
  hashtableText: string,
  fieldName: string,
  commandText: string,
) {
  const fieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*([^;\\r\\n}]+)`, "i"));
  const rawValue = fieldMatch?.[1]?.trim();
  if (!rawValue) {
    return null;
  }

  return normalizePowerShellFieldValue(rawValue, commandText);
}

function parseJsonBrowseBody(jsonText: string) {
  try {
    return JSON.parse(jsonText) as {
      action?: string;
      argument?: string;
      args?: string[];
      check?: string;
      expression?: string;
      session?: string;
      url?: string;
      selector?: string;
      key?: string;
      sessions?: string[];
      what?: string;
    };
  } catch {
    return null;
  }
}

function readPowerShellHashtableArrayField(
  hashtableText: string,
  fieldName: string,
  commandText: string,
) {
  const fieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*@\\(([^)]*)\\)`, "i"));
  const rawValue = fieldMatch?.[1]?.trim();
  if (!rawValue) {
    return null;
  }

  const values = [...rawValue.matchAll(/(['"`])([^'"`]*?)\1|\$([A-Za-z_][\w]*)/g)]
    .map((match) => match[2] ?? readPowerShellStringAssignment(commandText, match[3] ?? "") ?? null)
    .filter((value): value is string => Boolean(value));
  return formatSessionList(values);
}

function normalizePowerShellFieldValue(rawValue: string, commandText: string) {
  const quotedValue = readQuotedPowerShellValue(rawValue);
  if (quotedValue !== null) {
    return quotedValue;
  }

  const variableMatch = rawValue.match(/^\$([A-Za-z_][\w]*)$/);
  if (variableMatch?.[1]) {
    return readPowerShellStringAssignment(commandText, variableMatch[1]);
  }

  return null;
}

function readQuotedPowerShellValue(rawValue: string) {
  const trimmedValue = rawValue.trim();
  const quote = trimmedValue[0];
  if ((quote !== "'" && quote !== "\"" && quote !== "`") || trimmedValue.at(-1) !== quote) {
    return null;
  }

  return trimmedValue.slice(1, -1).trim();
}

function readPowerShellStringAssignment(commandText: string, variableName: string) {
  const assignmentMatch = commandText.match(new RegExp(`\\$${escapeRegExp(variableName)}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`, "i"));
  return assignmentMatch?.[2]?.trim() ?? null;
}

function formatBrowseAction(action: string) {
  switch (action) {
    case "doctor":
      return "check diagnostics";
    case "status":
      return "check status";
    case "open":
      return "open";
    case "snapshot":
      return "snapshot";
    case "click":
      return "click";
    case "fill":
      return "fill";
    case "type":
      return "type";
    case "key":
      return "press key";
    case "select":
      return "select";
    case "wait":
      return "wait";
    case "get":
      return "read";
    case "is":
      return "check";
    case "eval":
      return "evaluate JS";
    case "highlight":
      return "highlight";
    case "back":
      return "go back";
    case "forward":
      return "go forward";
    case "reload":
      return "reload";
    case "viewport":
      return "set viewport";
    case "screenshot":
      return "screenshot";
    case "cleanup":
      return "clean up sessions";
    case "stop":
      return "stop";
    case "refs":
      return "list refs";
    default:
      return collapseWhitespace(action);
  }
}

function formatSessionList(sessions: string[] | null | undefined) {
  return sessions?.length ? sessions.join(", ") : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
