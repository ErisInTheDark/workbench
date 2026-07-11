/*
 * Exports:
 * - BROWSE_COMMAND_MATCHERS: semantic command matcher for wb browse commands. Keywords: browse, workbench, cli, command matcher.
 * - isBrowseCommandMatcherClaim: detect Browse matcher ids for specialized sequence rendering. Keywords: browse, command matcher, sequence.
 * - parseBrowseSequenceCommandOutput: parse streamed or complete Browse output into semantic result metadata. Keywords: browse, output, detail rows.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition, ThreadCommandDetailRow, ThreadCommandDisplayPart } from "./types";

const BROWSE_MATCHER_ID = "browse.command";

interface BrowseCommandSummary {
  detailRows?: ThreadCommandDetailRow[];
  session: string | null;
  summaryParts: ThreadCommandDisplayPart[];
}

export const BROWSE_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: BROWSE_MATCHER_ID,
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length) {
        return null;
      }
      const summary = summarizeBrowseCommand(stage.text);
      if (!summary) {
        return null;
      }
      return CommandMatcher.Result({
        detailRows: summary.detailRows,
        hideCommandCwd: true,
        hideCommandOutput: true,
        remainingCommand: null,
        stop: true,
        summaryParts: summary.summaryParts,
        summaryStats: { webRequests: 1 },
      });
    },
  }),
];

function summarizeBrowseCommand(commandText: string): BrowseCommandSummary | null {
  const tokens = tokenizeCommand(commandText.trim());
  if (!tokens || !/^wb(?:\.cmd)?$/iu.test(tokens[0] ?? "") || tokens[1] !== "browse") {
    return null;
  }
  const operation = tokens[2];
  const session = readFlag(tokens, "--session");
  if (operation === "run") {
    const commands = readRepeatedFlag(tokens, "--command");
    const scriptPath = readFlag(tokens, "--script-path");
    const summary = readFlag(tokens, "--summary");
    const detailRows = commands.map((command, index) => buildBrowseDetailRow(command, index));
    const summaryParts: ThreadCommandDisplayPart[] = summary
      ? [CommandMatcher.Text("Browse: "), primary(summary)]
      : scriptPath
        ? [CommandMatcher.Text("Browse: run script "), CommandMatcher.Code(scriptPath)]
        : [CommandMatcher.Text(`Browse: run ${commands.length} ${pluralize(commands.length, "action")}`)];
    appendSession(summaryParts, session);
    return { detailRows, session, summaryParts };
  }
  if (operation === "raw") {
    const separator = tokens.indexOf("--");
    const rawAction = separator >= 0 ? tokens[separator + 1] : null;
    const summaryParts = [CommandMatcher.Text(`Browse: ${formatBrowseAction(rawAction ?? "raw")}`)];
    appendSession(summaryParts, session || readFlag(tokens.slice(separator + 1), "--session"));
    return { session, summaryParts };
  }
  if (["sessions", "stop", "forget"].includes(operation)) {
    const label = operation === "sessions" ? "list sessions" : operation === "stop" ? "stop session" : "forget persistent profile";
    const summaryParts = [CommandMatcher.Text(`Browse: ${label}`)];
    appendSession(summaryParts, session);
    return { session, summaryParts };
  }
  return null;
}

function tokenizeCommand(value: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && value[index + 1]) {
        current += value[index + 1];
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function readFlag(tokens: string[], flag: string) {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] ?? null : null;
}

function readRepeatedFlag(tokens: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === flag) {
      values.push(tokens[index + 1]);
      index += 1;
    }
  }
  return values;
}

function buildBrowseDetailRow(command: string, index: number): ThreadCommandDetailRow {
  const tokens = tokenizeCommand(command) ?? [command];
  const action = tokens[0] ?? "command";
  const targetText = readBrowseTarget(action, tokens.slice(1));
  return {
    id: `browse-command-${index}`,
    label: formatBrowseActionLabel(action),
    summaryParts: [CommandMatcher.Text(formatBrowseActionLabel(action))],
    ...(targetText
      ? {
        target: {
          kind: looksLikeUrl(targetText) ? "url" as const : "code" as const,
          text: targetText,
        },
      }
      : {}),
  };
}

function readBrowseTarget(action: string, args: string[]) {
  if (["open", "click", "fill", "get", "is", "highlight", "select", "eval", "wait"].includes(action)) {
    return args.filter((value) => !value.startsWith("--"))[0] ?? null;
  }
  if (["mouse", "move"].includes(action)) {
    return args.join(" ") || null;
  }
  return null;
}

function formatBrowseActionLabel(action: string) {
  const labels: Record<string, string> = {
    cleanup: "Clean up",
    click: "Click",
    doctor: "Diagnostics",
    eval: "Evaluate",
    fill: "Fill",
    forget: "Forget persistent profile",
    get: "Read",
    highlight: "Highlight",
    is: "Check",
    key: "Press key",
    open: "Open",
    refs: "Refs",
    reload: "Reload",
    screenshot: "Screenshot",
    select: "Select",
    snapshot: "Snapshot",
    status: "Status",
    stop: "Stop",
    type: "Type",
    viewport: "Viewport",
    wait: "Wait",
  };
  return labels[action] ?? action.replace(/[-_]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

function formatBrowseAction(action: string) {
  return formatBrowseActionLabel(action).toLowerCase();
}

function appendSession(parts: ThreadCommandDisplayPart[], session: string | null) {
  if (session) {
    parts.push(CommandMatcher.Text(" in "), CommandMatcher.Code(session));
  }
}

function primary(text: string): ThreadCommandDisplayPart {
  return { text, type: "text", variant: "primary" };
}

function looksLikeUrl(value: string) {
  return /^https?:\/\//iu.test(value);
}

export function isBrowseCommandMatcherClaim(value: string | null | undefined) {
  return value?.split(",").some((claim) => claim.trim() === BROWSE_MATCHER_ID) ?? false;
}

type BrowseOutputRow = Partial<Pick<ThreadCommandDetailRow, "detailKind" | "detailLabel" | "detailText" | "durationMs" | "state">>;

export function parseBrowseSequenceCommandOutput(output: string | null | undefined): BrowseOutputRow[] {
  const events = String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => parseRecord(line))
    .filter((event): event is Record<string, unknown> => Boolean(event));
  if (events.some((event) => String(event.type ?? "").startsWith("browse-"))) {
    return parseProgressEvents(events);
  }
  const response = parseRecord(readFirstJsonObject(String(output ?? "")));
  if (!response) {
    return [];
  }
  return Array.isArray(response.results)
    ? response.results.map((result) => formatBrowseResult(result))
    : typeof response.action === "string"
      ? [formatBrowseResult(response)]
      : [];
}

function parseProgressEvents(events: Record<string, unknown>[]) {
  const rows: BrowseOutputRow[] = [];
  const ensure = (index: number) => rows[index] ??= { state: "queued" };
  for (const event of events) {
    const type = String(event.type ?? "");
    if (type === "browse-sequence-start" && typeof event.totalActions === "number") {
      for (let index = 0; index < event.totalActions; index += 1) {
        ensure(index);
      }
      continue;
    }
    const index = typeof event.index === "number" ? Math.trunc(event.index) : -1;
    if (index >= 0 && type === "browse-action-start") {
      rows[index] = { ...ensure(index), state: "inProgress" };
    } else if (index >= 0 && type === "browse-action-complete") {
      rows[index] = { ...ensure(index), ...formatBrowseResult(event.result) };
    } else if (type === "browse-sequence-complete" && Array.isArray(event.results)) {
      event.results.forEach((result, resultIndex) => {
        rows[resultIndex] = { ...ensure(resultIndex), ...formatBrowseResult(result) };
      });
    }
  }
  return rows;
}

function formatBrowseResult(value: unknown): BrowseOutputRow {
  if (!isRecord(value)) {
    return { state: "failed" };
  }
  const ok = value.ok === true;
  const error = typeof value.error === "string" ? value.error : "";
  const stderr = typeof value.stderr === "string" ? value.stderr.trim() : "";
  const stdout = typeof value.stdout === "string" ? value.stdout.trim() : "";
  const detailText = error || stderr || stdout;
  return {
    ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    ...(detailText
      ? {
        detailKind: error || stderr ? "error" as const : "result" as const,
        detailLabel: error ? "Error" : stderr ? "stderr" : "stdout",
        detailText,
      }
      : {}),
    state: ok ? "completed" : "failed",
  };
}

function parseRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readFirstJsonObject(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end >= start ? value.slice(start, end + 1) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pluralize(count: number, singular: string) {
  return count === 1 ? singular : `${singular}s`;
}
