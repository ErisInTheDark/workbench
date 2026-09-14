/*
 * Exports:
 * - BROWSE_COMMAND_MATCHERS: semantic command matcher for wb browse commands. Keywords: browse, workbench, cli, command matcher.
 * - isBrowseCommandMatcherClaim: detect Browse matcher ids for specialized sequence rendering. Keywords: browse, command matcher, sequence.
 * - parseBrowseSequenceCommandOutput: parse streamed or complete Browse output into semantic result metadata. Keywords: browse, output, detail rows.
 */
import { CommandMatcher } from "./core";
import { tokenizeCommand } from "./helpers";
import type { CommandMatcherDefinition, ThreadCommandDetailRow } from "./types";
import {
  getWorkbenchCommandRendering,
  type WorkbenchCommandPresentationName,
} from "./workbench-command-rendering";

const BROWSE_MATCHER_ID = "browse.command";

interface BrowseCommandPresentation {
  argumentsValue: { [key: string]: string | string[] };
  name: WorkbenchCommandPresentationName;
}

export const BROWSE_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: BROWSE_MATCHER_ID,
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length) {
        return null;
      }
      const presentation = parseBrowseCommandPresentation(stage.text);
      if (!presentation) {
        return null;
      }
      return getWorkbenchCommandRendering(presentation.name, presentation.argumentsValue)?.result ?? null;
    },
  }),
];

function parseBrowseCommandPresentation(commandText: string): BrowseCommandPresentation | null {
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
    return {
      argumentsValue: {
        commands,
        ...(scriptPath ? { scriptPath } : {}),
        ...(session ? { session } : {}),
        ...(summary ? { summary } : {}),
      },
      name: "browse_run",
    };
  }
  if (operation === "raw") {
    const separator = tokens.indexOf("--");
    const rawAction = separator >= 0 ? tokens[separator + 1] ?? "raw" : "raw";
    const resolvedSession = session || readFlag(tokens.slice(separator + 1), "--session");
    return {
      argumentsValue: { rawAction, ...(resolvedSession ? { session: resolvedSession } : {}) },
      name: "browse_raw",
    };
  }
  if (["sessions", "stop", "forget"].includes(operation)) {
    return {
      argumentsValue: { ...(session ? { session } : {}) },
      name: `browse_${operation}` as WorkbenchCommandPresentationName,
    };
  }
  return null;
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
