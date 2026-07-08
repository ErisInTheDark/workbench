/*
 * Exports:
 * - BROWSE_WEB_REQUEST_COMMAND_MATCHERS: command-summary matchers for Workbench Browse API web requests. Keywords: browse, web request, command matcher.
 * - isBrowseWebRequestMatcherClaim: detect Browse request matcher ids for specialized sequence rendering. Keywords: browse, command matcher, sequence.
 * - parseBrowseSequenceCommandOutput: parse Browse sequence endpoint output into per-action semantic result metadata. Keywords: browse, sequence, output, detail rows.
 */
import { CommandMatcher } from "./core";
import { collapseWhitespace } from "./helpers";
import type { CommandMatcherDefinition, ThreadCommandDetailRow, ThreadCommandDisplayPart } from "./types";

interface BrowseRequestSummary {
  action: string;
  detailRows?: ThreadCommandDetailRow[];
  hideCommandOutput?: boolean;
  isBrowseRequest?: boolean;
  session: string | null;
  summaryText?: string | null;
  target: string | null;
  totalActions?: number;
}

const BROWSE_ROUTE_PATTERN = /https?:\/\/127\.0\.0\.1:3002\/api\/browse\b|https?:\/\/localhost:3002\/api\/browse\b|['"`]\/api\/browse['"`]/i;
const BROWSE_ENDPOINT_REFERENCE_PATTERN = /(?:https?:\/\/(?:127\.0\.0\.1|localhost):3002)?\/api\/browse(?:\/sessions)?\b|['"`]\/api\/browse(?:\/sessions)?['"`]/gi;
const BROWSE_SESSIONS_ROUTE_PATTERN = /(?:https?:\/\/(?:127\.0\.0\.1|localhost):3002)?\/api\/browse\/sessions\b/i;

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
        detailRows: summary.detailRows,
        hideCommandCwd: summary.isBrowseRequest === true,
        hideCommandOutput: summary.hideCommandOutput ?? summary.isBrowseRequest === true,
        remainingCommand: null,
        stop: true,
        summaryParts: buildBrowseRequestSummaryParts(summary),
        summaryStats: { webRequests: 1 },
      });
    },
  }),
];

function buildBrowseRequestSummaryParts(summary: BrowseRequestSummary): ThreadCommandDisplayPart[] {
  const parts: ThreadCommandDisplayPart[] = [];
  if (summary.summaryText) {
    parts.push(CommandMatcher.Text("Browse: "));
    parts.push({
      text: summary.summaryText,
      type: "text",
      variant: "primary",
    });
  } else {
    parts.push(CommandMatcher.Text(summary.totalActions
      ? `Browse: run ${summary.totalActions} ${pluralize(summary.totalActions, "action")}`
      : `Browse: ${formatBrowseAction(summary.action)}`));
  }

  if (!summary.summaryText && summary.target) {
    parts.push(CommandMatcher.Text(" "));
    parts.push(isBrowseActionTargetCode(summary.action) ? CommandMatcher.Code(summary.target) : CommandMatcher.Text(summary.target));
  }

  if (!summary.summaryText && summary.session) {
    parts.push(CommandMatcher.Text(" in session "));
    parts.push(CommandMatcher.Code(summary.session));
  }
  if (summary.summaryText && summary.session) {
    parts.push(CommandMatcher.Text(" in "));
    parts.push(CommandMatcher.Code(summary.session));
  }

  return parts;
}

function buildBrowseActionSummaryParts(action: BrowseJsonAction): ThreadCommandDisplayPart[] {
  const parts: ThreadCommandDisplayPart[] = [
    CommandMatcher.Text(formatBrowseAction(action.action ?? "request")),
  ];
  const target = readBrowseActionTarget(action);
  if (target) {
    parts.push(CommandMatcher.Text(" "));
    parts.push(isBrowseActionTargetCode(action.action) ? CommandMatcher.Code(target) : CommandMatcher.Text(target));
  }
  if (action.session) {
    parts.push(CommandMatcher.Text(" in "));
    parts.push(CommandMatcher.Text(action.session));
  }
  return parts;
}

function formatBrowseActionLabel(action: string | null | undefined) {
  switch (action) {
    case "doctor":
      return "Diagnostics";
    case "status":
      return "Status";
    case "open":
      return "Open";
    case "snapshot":
      return "Snapshot";
    case "click":
      return "Click";
    case "cursor":
      return "Cursor";
    case "fill":
      return "Fill";
    case "type":
      return "Type";
    case "key":
      return "Press key";
    case "mouseClick":
    case "mouse":
      return "Mouse click";
    case "mouseDrag":
      return "Mouse drag";
    case "mouseHover":
      return "Mouse hover";
    case "mouseScroll":
      return "Mouse scroll";
    case "select":
      return "Select";
    case "wait":
      return "Wait";
    case "get":
      return "Read";
    case "is":
      return "Check";
    case "eval":
      return "Evaluate";
    case "highlight":
      return "Highlight";
    case "back":
      return "Back";
    case "forward":
      return "Forward";
    case "reload":
      return "Reload";
    case "viewport":
      return "Viewport";
    case "screenshot":
      return "Screenshot";
    case "sessions":
      return "Sessions";
    case "cleanup":
      return "Clean up";
    case "stop":
      return "Stop";
    case "refs":
      return "Refs";
    default:
      return collapseWhitespace(action ?? "Request") || "Request";
  }
}

function isBrowseActionTargetCode(action: string | null | undefined) {
  return action === "open"
    || action === "click"
    || action === "fill"
    || action === "select"
    || action === "highlight"
    || action === "eval"
    || action === "get"
    || action === "is"
    || action === "mouseClick"
    || action === "mouseDrag"
    || action === "mouseHover"
    || action === "mouseScroll";
}

function readBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const mixedScriptSummary = readMixedBrowseScriptSummary(commandText);
  if (mixedScriptSummary) {
    return mixedScriptSummary;
  }

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

  if (BROWSE_SESSIONS_ROUTE_PATTERN.test(commandText)) {
    return {
      action: "sessions",
      isBrowseRequest: true,
      session: readUrlQueryValue(commandText, "session"),
      target: readUrlQueryValue(commandText, "projectId"),
    };
  }

  return { action: "request", session: null, target: null };
}

function readMixedBrowseScriptSummary(commandText: string): BrowseRequestSummary | null {
  const endpointReferences = countBrowseEndpointReferences(commandText);
  if (endpointReferences < 2) {
    return null;
  }

  const actions = readPowerShellHashtableSequenceActions(commandText);
  const uniqueSessions = Array.from(new Set(actions.map((action) => action.session).filter((session): session is string => Boolean(session))));
  return {
    action: "request",
    detailRows: actions.length ? actions.map(buildBrowseActionDetailRow) : undefined,
    hideCommandOutput: false,
    isBrowseRequest: true,
    session: uniqueSessions.length === 1 ? uniqueSessions[0] : formatSessionList(uniqueSessions),
    summaryText: "run mixed script",
    target: null,
    totalActions: actions.length || endpointReferences,
  };
}

function countBrowseEndpointReferences(commandText: string) {
  return [...commandText.matchAll(new RegExp(BROWSE_ENDPOINT_REFERENCE_PATTERN.source, "gi"))].length;
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

  if (Array.isArray(parsed)) {
    return summarizeBrowseSequence(parsed, null);
  }

  if (parsed.actions?.length) {
    return summarizeBrowseSequence(parsed.actions, parsed.summary ?? parsed.description ?? null);
  }

  if (parsed.script || parsed.scriptPath) {
    return summarizeBrowseScriptRequest(parsed);
  }

  if (parsed.action) {
    return {
      action: parsed.action,
      detailRows: [buildBrowseActionDetailRow(parsed, 0)],
      isBrowseRequest: true,
      session: parsed.session ?? null,
      target: parsed.url
        ?? parsed.selector
        ?? parsed.ref
        ?? formatMouseCoordinates(parsed)
        ?? parsed.key
        ?? parsed.what
        ?? parsed.check
        ?? parsed.expression
        ?? formatWaitMilliseconds(parsed)
        ?? parsed.argument
        ?? formatSessionList(parsed.sessions),
    };
  }

  return summarizeBrowseArgs(parsed.args);
}

function readPowerShellHashtableBrowseRequestSummary(commandText: string): BrowseRequestSummary | null {
  const sequenceSummary = readPowerShellHashtableBrowseSequenceSummary(commandText);
  if (sequenceSummary) {
    return sequenceSummary;
  }

  const action = readPowerShellHashtableField(commandText, "action", commandText);
  if (!action) {
    return null;
  }
  const parsedAction = readPowerShellHashtableBrowseAction(commandText, commandText) ?? { action };

  return {
    action,
    detailRows: [buildBrowseActionDetailRow(parsedAction, 0)],
    isBrowseRequest: true,
    session: readPowerShellHashtableField(commandText, "session", commandText),
    target: readPowerShellHashtableField(commandText, "url", commandText)
      ?? readPowerShellHashtableField(commandText, "selector", commandText)
      ?? readPowerShellHashtableField(commandText, "ref", commandText)
      ?? formatMouseCoordinates(parsedAction)
      ?? readPowerShellHashtableField(commandText, "key", commandText)
      ?? readPowerShellHashtableField(commandText, "what", commandText)
      ?? readPowerShellHashtableField(commandText, "check", commandText)
      ?? readPowerShellHashtableField(commandText, "expression", commandText)
      ?? formatWaitMilliseconds(parsedAction)
      ?? readPowerShellHashtableField(commandText, "argument", commandText)
      ?? readPowerShellHashtableArrayField(commandText, "sessions", commandText),
  };
}

function readPowerShellHashtableBrowseSequenceSummary(commandText: string): BrowseRequestSummary | null {
  if (!/\bactions\s*=\s*@\(/i.test(commandText)) {
    return null;
  }

  const actions = readPowerShellHashtableSequenceActions(commandText);
  const summary = readPowerShellHashtableField(commandText, "summary", commandText)
    ?? readPowerShellHashtableField(commandText, "description", commandText);
  return actions.length ? summarizeBrowseSequence(actions, summary) : null;
}

function readPowerShellHashtableSequenceActions(commandText: string): BrowseJsonAction[] {
  const actionBlocks = readPowerShellHashtableBlocks(commandText)
    .filter((block) => /(?:^|[;{])\s*action\s*=/i.test(block) && !/\bactions\s*=/i.test(block));
  if (actionBlocks.length) {
    return actionBlocks
      .map((block) => readPowerShellHashtableBrowseAction(block, commandText))
      .filter((action): action is BrowseJsonAction => action !== null);
  }

  return [...commandText.matchAll(/(?:^|[;{])\s*action\s*=\s*([^;\r\n}]+)/gi)]
    .map((match) => normalizePowerShellFieldValue(match[1] ?? "", commandText))
    .filter((action): action is string => Boolean(action))
    .map((action) => ({ action }));
}

function readPowerShellHashtableBlocks(commandText: string) {
  const blocks: string[] = [];
  let index = 0;
  while (index < commandText.length) {
    const startIndex = commandText.indexOf("@{", index);
    if (startIndex < 0) {
      break;
    }

    const endIndex = findPowerShellHashtableEnd(commandText, startIndex + 2);
    if (endIndex < 0) {
      index = startIndex + 2;
      continue;
    }

    blocks.push(commandText.slice(startIndex, endIndex + 1));
    index = startIndex + 2;
  }
  return blocks;
}

function findPowerShellHashtableEnd(commandText: string, startIndex: number) {
  let depth = 1;
  let quote: string | null = null;
  for (let index = startIndex; index < commandText.length; index += 1) {
    const character = commandText[index];
    if (quote) {
      if (character === "`") {
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "@" && commandText[index + 1] === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function readPowerShellHashtableBrowseAction(
  blockText: string,
  commandText: string,
): BrowseJsonAction | null {
  const action = readPowerShellHashtableField(blockText, "action", commandText);
  if (!action) {
    return null;
  }

  return {
    action,
    argument: readPowerShellHashtableField(blockText, "argument", commandText) ?? undefined,
    check: readPowerShellHashtableField(blockText, "check", commandText) ?? undefined,
    expression: readPowerShellHashtableField(blockText, "expression", commandText) ?? undefined,
    force: readPowerShellHashtableBooleanField(blockText, "force"),
    fromX: readPowerShellHashtableNumberField(blockText, "fromX"),
    fromY: readPowerShellHashtableNumberField(blockText, "fromY"),
    key: readPowerShellHashtableField(blockText, "key", commandText) ?? undefined,
    ms: readPowerShellHashtableNumberField(blockText, "ms"),
    deltaX: readPowerShellHashtableNumberField(blockText, "deltaX"),
    deltaY: readPowerShellHashtableNumberField(blockText, "deltaY"),
    ref: readPowerShellHashtableField(blockText, "ref", commandText) ?? undefined,
    returnXPath: readPowerShellHashtableBooleanField(blockText, "returnXPath"),
    selector: readPowerShellHashtableField(blockText, "selector", commandText) ?? undefined,
    session: readPowerShellHashtableField(blockText, "session", commandText) ?? undefined,
    state: readPowerShellHashtableField(blockText, "state", commandText) ?? undefined,
    type: readPowerShellHashtableField(blockText, "type", commandText) ?? undefined,
    toX: readPowerShellHashtableNumberField(blockText, "toX"),
    toY: readPowerShellHashtableNumberField(blockText, "toY"),
    url: readPowerShellHashtableField(blockText, "url", commandText) ?? undefined,
    value: readPowerShellHashtableField(blockText, "value", commandText) ?? undefined,
    what: readPowerShellHashtableField(blockText, "what", commandText) ?? undefined,
    x: readPowerShellHashtableNumberField(blockText, "x"),
    y: readPowerShellHashtableNumberField(blockText, "y"),
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
    detailRows: [buildBrowseActionDetailRow({ action, args: normalizedArgs }, 0)],
    hideCommandOutput: false,
    isBrowseRequest: true,
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
    case "mouse":
      return formatMouseArgsTarget(args);
    default:
      return null;
  }
}

function formatMouseArgsTarget(args: string[]) {
  const subcommand = args[1];
  if ((subcommand === "click" || subcommand === "hover") && args[2] && args[3] && !args[2].startsWith("-") && !args[3].startsWith("-")) {
    return `${args[2]},${args[3]}`;
  }
  if (subcommand === "drag" && args[2] && args[3] && args[4] && args[5]) {
    return `${args[2]},${args[3]} -> ${args[4]},${args[5]}`;
  }
  if (subcommand === "scroll" && args[2] && args[3] && args[4] && args[5]) {
    return `${args[2]},${args[3]} scroll ${args[4]},${args[5]}`;
  }
  return null;
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
  if (!bodyText || !/^\s*[\[{]/.test(bodyText)) {
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
  const quotedFieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`, "i"));
  const quotedValue = quotedFieldMatch?.[2]?.trim();
  if (quotedValue) {
    return quotedValue;
  }

  const fieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*([^;\\r\\n}]+)`, "i"));
  const rawValue = fieldMatch?.[1]?.trim();
  if (!rawValue) {
    return null;
  }

  return normalizePowerShellFieldValue(rawValue, commandText);
}

function readPowerShellHashtableBooleanField(
  hashtableText: string,
  fieldName: string,
) {
  const fieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*(\\$?true|\\$?false|true|false)`, "i"));
  const rawValue = fieldMatch?.[1]?.toLowerCase().replace(/^\$/, "");
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  return undefined;
}

function readPowerShellHashtableNumberField(
  hashtableText: string,
  fieldName: string,
) {
  const fieldMatch = hashtableText.match(new RegExp(`(?:^|[;{])\\s*${escapeRegExp(fieldName)}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
  const numberValue = Number(fieldMatch?.[1]);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function parseJsonBrowseBody(jsonText: string) {
  try {
    return JSON.parse(jsonText) as BrowseJsonBody;
  } catch {
    return null;
  }
}

type BrowseJsonAction = {
  action?: string;
  args?: string[];
  argument?: string;
  check?: string;
  deltaX?: number;
  deltaY?: number;
  expression?: string;
  force?: boolean;
  fromX?: number;
  fromY?: number;
  key?: string;
  ms?: number;
  projectId?: string;
  ref?: string;
  returnXPath?: boolean;
  selector?: string;
  session?: string;
  state?: string;
  type?: string;
  toX?: number;
  toY?: number;
  url?: string;
  value?: string;
  what?: string;
  x?: number;
  y?: number;
};

type BrowseJsonBody =
  | Array<BrowseJsonAction>
  | {
      action?: string;
      actions?: BrowseJsonAction[];
      argument?: string;
      args?: string[];
      check?: string;
      description?: string;
      deltaX?: number;
      deltaY?: number;
      expression?: string;
      force?: boolean;
      fromX?: number;
      fromY?: number;
      ms?: number;
      ref?: string;
      returnXPath?: boolean;
      session?: string;
      projectId?: string;
      url?: string;
      selector?: string;
      key?: string;
      sessions?: string[];
      script?: string;
      scriptPath?: string;
      summary?: string;
      toX?: number;
      toY?: number;
      what?: string;
      x?: number;
      y?: number;
    };

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

function readUrlQueryValue(commandText: string, fieldName: string) {
  const match = commandText.match(new RegExp(`[?&]${escapeRegExp(fieldName)}=([^\\s'"&#]+)`, "i"));
  const encodedValue = match?.[1];
  if (!encodedValue) {
    return null;
  }

  try {
    return decodeURIComponent(encodedValue.replace(/\+/g, " ")).trim() || null;
  } catch {
    return encodedValue.trim() || null;
  }
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
    case "cursor":
      return "show cursor";
    case "fill":
      return "fill";
    case "type":
      return "type";
    case "key":
      return "press key";
    case "mouseClick":
    case "mouse":
      return "mouse click";
    case "mouseDrag":
      return "mouse drag";
    case "mouseHover":
      return "mouse hover";
    case "mouseScroll":
      return "mouse scroll";
    case "select":
      return "select";
    case "wait":
      return "wait";
    case "get":
      return "read";
    case "is":
      return "check";
    case "eval":
      return "evaluate";
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
    case "sessions":
      return "list sessions";
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

function summarizeBrowseScriptRequest(parsed: Extract<BrowseJsonBody, { script?: string; scriptPath?: string }>): BrowseRequestSummary {
  const scriptPath = typeof parsed.scriptPath === "string" ? parsed.scriptPath.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const estimatedActions = typeof parsed.script === "string" ? estimateBrowseMarkdownActionCount(parsed.script) : null;
  return {
    action: "script",
    hideCommandOutput: false,
    isBrowseRequest: true,
    session: parsed.session ?? null,
    summaryText: summary || (scriptPath ? `run BrowseMD ${scriptPath}` : "run inline BrowseMD"),
    target: scriptPath || null,
    totalActions: estimatedActions ?? undefined,
  };
}

function estimateBrowseMarkdownActionCount(script: string) {
  let actions = 0;
  let inFence = false;
  for (const line of script.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmedLine = line.trim();
    if (/^```/u.test(trimmedLine)) {
      if (!inFence) {
        actions += 1;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmedLine || trimmedLine.startsWith("# ") || trimmedLine.startsWith("## ") || trimmedLine.startsWith("// ")) {
      continue;
    }
    actions += 1;
  }
  return actions || null;
}

function summarizeBrowseSequence(actions: BrowseJsonAction[], summaryText: string | null): BrowseRequestSummary | null {
  const normalizedActions = actions.filter((action) => action.action);
  if (!normalizedActions.length) {
    return null;
  }

  const firstAction = normalizedActions[0];
  const lastAction = normalizedActions.at(-1);
  const uniqueSessions = Array.from(new Set(normalizedActions.map((action) => action.session).filter((session): session is string => Boolean(session))));
  return {
    action: firstAction.action ?? "sequence",
    detailRows: normalizedActions.map(buildBrowseActionDetailRow),
    isBrowseRequest: true,
    session: uniqueSessions.length === 1 ? uniqueSessions[0] : formatSessionList(uniqueSessions),
    summaryText: summaryText?.trim() || null,
    target: formatBrowseSequenceTarget(firstAction, lastAction),
    totalActions: normalizedActions.length,
  };
}

function buildBrowseActionDetailRow(action: BrowseJsonAction, index: number): ThreadCommandDetailRow {
  return {
    contextText: action.session ?? null,
    id: `browse-action:${index}:${action.action ?? "action"}`,
    label: formatBrowseActionLabel(action.action),
    summaryParts: buildBrowseActionSummaryParts(action),
    target: readBrowseActionDetailTarget(action),
  };
}

function readBrowseActionDetailTarget(action: BrowseJsonAction): ThreadCommandDetailRow["target"] {
  const target = action.action === "stop"
    ? action.session ?? (action.force === true || action.args?.some((arg) => arg.toLowerCase() === "--force") ? "current session" : null)
    : readBrowseActionTarget(action);
  if (!target) {
    return null;
  }

  if (action.action === "open" || (action.action === "stop" && looksLikeUrl(target))) {
    return { kind: "url", text: target };
  }
  if (isBrowseActionTargetCode(action.action)) {
    return { kind: "code", text: target };
  }
  return { kind: "text", text: target };
}

function looksLikeUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function formatBrowseSequenceTarget(
  firstAction: BrowseJsonAction,
  lastAction: BrowseJsonAction | undefined,
) {
  const firstTarget = readBrowseActionTarget(firstAction);
  const lastTarget = lastAction ? readBrowseActionTarget(lastAction) : null;
  if (firstTarget && lastTarget && firstTarget !== lastTarget) {
    return `${firstTarget} -> ${lastTarget}`;
  }

  return firstTarget ?? lastTarget ?? null;
}

function readBrowseActionTarget(action: BrowseJsonAction) {
  if (action.action === "wait") {
    const timeoutMs = formatWaitMilliseconds(action);
    if (action.type === "timeout" && timeoutMs) {
      return timeoutMs;
    }
    if (action.argument && action.state) {
      return `${action.argument} ${action.state}`;
    }
  }

  if (action.args?.length) {
    return getBrowseArgsTarget(action.args);
  }

  const mouseCoordinates = formatMouseCoordinates(action);
  if (mouseCoordinates) {
    return mouseCoordinates;
  }

  return action.url
    ?? action.selector
    ?? action.ref
    ?? action.key
    ?? action.projectId
    ?? action.what
    ?? action.check
    ?? action.expression
    ?? action.argument
    ?? null;
}

function formatMouseCoordinates(action: BrowseJsonAction) {
  if ((action.action === "mouseClick" || action.action === "mouseHover") && typeof action.x === "number" && typeof action.y === "number") {
    return `${action.x},${action.y}`;
  }
  if (
    action.action === "mouseDrag"
    && typeof action.fromX === "number"
    && typeof action.fromY === "number"
    && typeof action.toX === "number"
    && typeof action.toY === "number"
  ) {
    return `${action.fromX},${action.fromY} -> ${action.toX},${action.toY}`;
  }
  if (
    action.action === "mouseScroll"
    && typeof action.x === "number"
    && typeof action.y === "number"
    && typeof action.deltaX === "number"
    && typeof action.deltaY === "number"
  ) {
    return `${action.x},${action.y} scroll ${action.deltaX},${action.deltaY}`;
  }
  return null;
}

function formatWaitMilliseconds(action: BrowseJsonAction) {
  const milliseconds = typeof action.ms === "number" && Number.isFinite(action.ms)
    ? action.ms
    : action.argument;
  return milliseconds === undefined || milliseconds === null
    ? null
    : formatDurationArgument(String(milliseconds));
}

export function isBrowseWebRequestMatcherClaim(value: string | null | undefined) {
  return value?.split(",").some((claim) => claim.trim() === "browse.web-request") ?? false;
}

type BrowseSequenceOutputRow = Partial<Pick<ThreadCommandDetailRow, "detailKind" | "detailLabel" | "detailText" | "durationMs" | "state">>;

export function parseBrowseSequenceCommandOutput(output: string | null | undefined): BrowseSequenceOutputRow[] {
  const progressRows = parseBrowseSequenceProgressOutput(output ?? "");
  if (progressRows.length) {
    return progressRows;
  }

  const powershellRows = parsePowerShellBrowseObjectOutput(output ?? "");
  if (powershellRows.length) {
    return powershellRows;
  }

  const jsonText = readFirstJsonObject(output ?? "");
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isRecord(parsed)) {
      return [];
    }

    if (!Array.isArray(parsed.results)) {
      return typeof parsed.action === "string"
        ? [formatBrowseSequenceResult(parsed, { complete: true })]
        : [];
    }

    return parsed.results.map((result) => formatBrowseSequenceResult(result, { complete: true }));
  } catch {
    return [];
  }
}

function parseBrowseSequenceProgressOutput(output: string): BrowseSequenceOutputRow[] {
  const events = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonObject)
    .filter(isRecord);
  if (!events.some((event) => typeof event.type === "string" && event.type.startsWith("browse-"))) {
    return [];
  }

  const rows: BrowseSequenceOutputRow[] = [];
  const ensureRow = (index: number) => {
    while (rows.length <= index) {
      rows.push({ state: "queued" });
    }
    return rows[index];
  };

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "browse-sequence-start") {
      const totalActions = typeof event.totalActions === "number" && Number.isFinite(event.totalActions)
        ? Math.max(0, Math.trunc(event.totalActions))
        : 0;
      for (let index = 0; index < totalActions; index += 1) {
        ensureRow(index).state ??= "queued";
      }
      continue;
    }

    const index = typeof event.index === "number" && Number.isFinite(event.index)
      ? Math.trunc(event.index)
      : -1;
    if (index < 0) {
      if (type === "browse-sequence-complete" && Array.isArray(event.results)) {
        event.results.forEach((result, resultIndex) => {
          rows[resultIndex] = {
            ...ensureRow(resultIndex),
            ...formatBrowseSequenceResult(result, { complete: true }),
          };
        });
      }
      continue;
    }

    if (type === "browse-action-start") {
      ensureRow(index).state = "inProgress";
      continue;
    }

    if (type === "browse-action-complete") {
      rows[index] = {
        ...ensureRow(index),
        ...formatBrowseSequenceResult(event.result, { complete: true }),
      };
    }
  }

  return rows;
}

function formatBrowseSequenceResult(result: unknown, { complete = false }: { complete?: boolean } = {}): BrowseSequenceOutputRow {
  if (!isRecord(result)) {
    return complete ? { state: "completed" } : {};
  }

  const action = typeof result.action === "string" ? result.action : "";
  const error = typeof result.error === "string" ? result.error.trim() : "";
  const ok = typeof result.ok === "boolean" ? result.ok : !error;
  const state = complete ? (ok && !error ? "completed" : "failed") : undefined;
  const durationMs = typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
    ? result.durationMs
    : null;
  if (error) {
    return {
      detailKind: "error",
      detailLabel: "error",
      detailText: error,
      durationMs,
      state,
    };
  }

  if (action === "eval") {
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const evalOutput = readEvalStdoutResult(stdout);
    return {
      detailKind: evalOutput ? "result" : undefined,
      detailLabel: evalOutput ? "result" : null,
      detailText: evalOutput,
      durationMs,
      state,
    };
  }

  if (action === "wait") {
    return { durationMs, state };
  }

  if (action === "get" || action === "is") {
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const value = readGenericStdoutResult(stdout);
    return {
      detailKind: value ? "result" : undefined,
      detailLabel: value ? "result" : null,
      detailText: value,
      durationMs,
      state,
    };
  }

  if (action === "open") {
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const title = readStdoutStringField(stdout, "title");
    return {
      detailKind: title ? "text" : undefined,
      detailLabel: title ? "title" : null,
      detailText: title,
      durationMs,
      state,
    };
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const genericOutput = readGenericStdoutResult(stdout);
  return {
    detailKind: genericOutput ? "result" : undefined,
    detailLabel: genericOutput ? "result" : null,
    detailText: genericOutput,
    durationMs,
    state,
  };
}

function parsePowerShellBrowseObjectOutput(output: string): BrowseSequenceOutputRow[] {
  const error = readPowerShellObjectStringField(output, "error");
  const ok = readPowerShellObjectBooleanField(output, "ok");
  const durationMs = readPowerShellObjectNumberField(output, "durationMs");
  const stdout = readPowerShellObjectStdout(output);
  if (error || ok !== null || durationMs !== null || stdout) {
    return [{
      detailKind: error ? "error" : stdout ? "result" : undefined,
      detailLabel: error ? "error" : stdout ? "result" : null,
      detailText: error ?? stdout,
      durationMs,
      state: ok === false || error ? "failed" : "completed",
    }];
  }
  return [];
}

function readEvalStdoutResult(stdout: string) {
  const value = parseJsonObject(stdout);
  if (!isRecord(value) || !("result" in value)) {
    return null;
  }

  return formatEvalResultValue(value.result);
}

function formatEvalResultValue(value: unknown) {
  if (typeof value === "string") {
    return value.slice(0, 4000);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return null;
  }
}

function readGenericStdoutResult(stdout: string) {
  const value = parseJsonObject(stdout);
  return value === null ? null : formatCompactJsonValue(value);
}

function readStdoutStringField(stdout: string, fieldName: string) {
  const value = parseJsonObject(stdout);
  return isRecord(value) && typeof value[fieldName] === "string"
    ? collapseWhitespace(value[fieldName]).slice(0, 160)
    : null;
}

function parseJsonObject(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readPowerShellObjectStringField(output: string, fieldName: string) {
  const match = output.match(new RegExp(`(?:^|\\r?\\n)\\s*${escapeRegExp(fieldName)}\\s*:\\s*(.*)`, "i"));
  const value = match?.[1]?.trim();
  return value || null;
}

function readPowerShellObjectBooleanField(output: string, fieldName: string) {
  const value = readPowerShellObjectStringField(output, fieldName)?.toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function readPowerShellObjectNumberField(output: string, fieldName: string) {
  const value = readPowerShellObjectStringField(output, fieldName);
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function readPowerShellObjectStdout(output: string) {
  const match = output.match(/(?:^|\r?\n)\s*stdout\s*:\s*([\s\S]*?)(?=\r?\n\s*(?:action|args|session|steered|steerTurnId|timedOut)\s*:|\s*$)/i);
  const value = match?.[1]?.trim();
  if (!value) {
    return null;
  }

  const compactJson = readGenericStdoutResult(value);
  return compactJson ?? collapseWhitespace(value).slice(0, 400);
}

function formatCompactJsonValue(value: unknown) {
  if (typeof value === "string") {
    return collapseWhitespace(value).slice(0, 400);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  try {
    return collapseWhitespace(JSON.stringify(value)).slice(0, 400);
  } catch {
    return null;
  }
}

function readFirstJsonObject(value: string) {
  const startIndex = value.indexOf("{");
  const endIndex = value.lastIndexOf("}");
  return startIndex >= 0 && endIndex > startIndex ? value.slice(startIndex, endIndex + 1) : null;
}

function formatDurationArgument(value: string) {
  const durationMs = Number.parseInt(value, 10);
  return Number.isFinite(durationMs) && durationMs > 0 ? formatDurationMs(durationMs) : value;
}

function formatDurationMs(durationMs: number) {
  if (durationMs >= 1000 && durationMs % 1000 === 0) {
    return `${durationMs / 1000}s`;
  }
  return `${durationMs}ms`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}
