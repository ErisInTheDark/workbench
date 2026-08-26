/*
 * Exports:
 * - WorkbenchSubagentCommand/WorkbenchSubagentCommandTarget/parseWorkbenchSubagentCommand: parse semantic subagent actions, create metadata, ordered id/name targets, and messages from wb commands. Keywords: workbench, cli, subagent, parse, create, target, message.
 * - WorkbenchThreadTitleCommand/parseWorkbenchThreadTitleCommand/isWorkbenchThreadTitleSetMatcherClaim: parse title set/get actions and identify standalone title-set displays. Keywords: workbench, cli, thread, title, parse, matcher.
 * - WorkbenchThreadStatusCommand/parseWorkbenchThreadStatusCommand/isWorkbenchThreadStatusMatcherClaim: parse completed/blocked task status actions and identify standalone successful displays. Keywords: workbench, cli, thread, status, task, matcher.
 * - WORKBENCH_CLI_COMMAND_MATCHERS: shell-neutral matchers for wb title, status, subagent, and reload commands. Keywords: workbench, cli, title, status, subagent, reload.
 */
import type { CommandAction } from "../../../codex/generated/app-server/v2/CommandAction";

import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";
import {
    getWorkbenchCommandRendering,
} from "./workbench-command-rendering";

export type WorkbenchSubagentCommandAction = "create" | "list" | "message" | "profiles" | "settle" | "stop" | "wait";

export interface WorkbenchSubagentCommandTarget {
  kind: "id" | "name";
  value: string;
}

export interface WorkbenchSubagentCommand {
  action: WorkbenchSubagentCommandAction;
  message: string | null;
  name: string | null;
  profileId: string | null;
  targets: WorkbenchSubagentCommandTarget[];
  title: string | null;
  toParent: boolean;
}

export type WorkbenchThreadTitleCommand =
  | { action: "get" }
  | { action: "set"; title: string };

export interface WorkbenchThreadStatusCommand {
  status: "blocked" | "completed";
}

function readPowerShellHereString(command: string, startIndex: number) {
  const opener = command.slice(startIndex, startIndex + 2);
  if (opener !== "@'" && opener !== '@"') return null;

  let contentStart = startIndex + opener.length;
  if (command.startsWith("\r\n", contentStart)) contentStart += 2;
  else if (command[contentStart] === "\n") contentStart += 1;
  else return null;

  const terminatorPattern = opener === "@'"
    ? /\r?\n'@(?=$|\s|[;&|"])/gu
    : /\r?\n"@(?=$|\s|[;&|"])/gu;
  terminatorPattern.lastIndex = contentStart;
  const terminator = terminatorPattern.exec(command);
  if (!terminator) return null;
  return {
    nextIndex: terminator.index + terminator[0].length,
    value: command.slice(contentStart, terminator.index),
  };
}

function readValue(command: string, startIndex: number) {
  const hereString = readPowerShellHereString(command, startIndex);
  if (hereString) return hereString;

  let index = startIndex;
  const quote = command[index] === "\"" || command[index] === "'" ? command[index++] : null;
  let value = "";

  while (index < command.length) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        if (command[index + 1] === quote) {
          value += quote;
          index += 2;
          continue;
        }
        return { nextIndex: index + 1, value };
      }
      if (character === "\\" && command[index + 1] === quote) {
        value += quote;
        index += 2;
        continue;
      }
    } else if (/\s|[;&|]/u.test(character)) {
      return { nextIndex: index, value };
    }
    value += character;
    index += 1;
  }

  return { nextIndex: index, value };
}

function readFlagValues(command: string, flag: string) {
  const pattern = new RegExp(`(?:^|\\s)--${flag}(?:\\s+|=)`, "gu");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    const result = readValue(command, match.index + match[0].length);
    if (result.value) values.push(result.value);
    pattern.lastIndex = Math.max(pattern.lastIndex, result.nextIndex);
  }
  return values;
}

function readFlagValue(command: string, flag: string) {
  return readFlagValues(command, flag)[0] ?? null;
}

function hasBooleanFlag(command: string, flag: string) {
  return new RegExp(`(?:^|\\s)--${flag}(?=\\s|$|[;&|])`, "u").test(command);
}

function readSubagentTargets(command: string) {
  const pattern = /(?:^|\s)--(id|name)(?:\s+|=)/gu;
  const targets: WorkbenchSubagentCommandTarget[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    const result = readValue(command, match.index + match[0].length);
    if (result.value) {
      targets.push({
        kind: match[1] as WorkbenchSubagentCommandTarget["kind"],
        value: result.value,
      });
    }
    pattern.lastIndex = Math.max(pattern.lastIndex, result.nextIndex);
  }
  return targets;
}

function parseSingleWorkbenchSubagentCommand(command: string): WorkbenchSubagentCommand | null {
  const normalized = command.trim();
  const actionMatch = normalized.match(/^wb(?:\.cmd)?\s+subagent\s+(list|profiles|create|wait|message|stop|settle)\b/iu);
  if (!actionMatch) return null;
  const action = actionMatch[1].toLowerCase() as WorkbenchSubagentCommandAction;
  return {
    action,
    message: readFlagValue(normalized, "message"),
    name: action === "create" ? readFlagValue(normalized, "name") : null,
    profileId: readFlagValue(normalized, "profile"),
    targets: action === "message" || action === "settle" || action === "stop" || action === "wait"
      ? readSubagentTargets(normalized)
      : [],
    title: readFlagValue(normalized, "title"),
    toParent: hasBooleanFlag(normalized, "parent"),
  };
}

export function parseWorkbenchSubagentCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchSubagentCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchSubagentCommand(action.command);
    if (parsedAction) {
      return parsedAction;
    }
  }
  return parseSingleWorkbenchSubagentCommand(command);
}

function parseSingleWorkbenchThreadTitleCommand(command: string): WorkbenchThreadTitleCommand | null {
  const normalized = command.trim();
  if (/^wb(?:\.cmd)?\s+thread\s+title\s+get(?:\s|$)/iu.test(normalized)) return { action: "get" };
  if (!/^wb(?:\.cmd)?\s+thread\s+title(?:\s|$)/iu.test(normalized)) return null;
  const title = readFlagValue(normalized, "title");
  return title ? { action: "set", title } : null;
}

export function parseWorkbenchThreadTitleCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchThreadTitleCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchThreadTitleCommand(action.command);
    if (parsedAction) return parsedAction;
  }
  return parseSingleWorkbenchThreadTitleCommand(command);
}

export function isWorkbenchThreadTitleSetMatcherClaim(claimedBy: string | null | undefined) {
  return claimedBy?.split(",").includes("workbench-cli.thread-title-set") ?? false;
}

function parseSingleWorkbenchThreadStatusCommand(command: string): WorkbenchThreadStatusCommand | null {
  const normalized = command.trim();
  if (!/^wb(?:\.cmd)?\s+thread\s+status(?:\s|$)/iu.test(normalized)) return null;
  const status = readFlagValue(normalized, "status");
  return status === "completed" || status === "blocked" ? { status } : null;
}

export function parseWorkbenchThreadStatusCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchThreadStatusCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchThreadStatusCommand(action.command);
    if (parsedAction) return parsedAction;
  }
  return parseSingleWorkbenchThreadStatusCommand(command);
}

export function isWorkbenchThreadStatusMatcherClaim(claimedBy: string | null | undefined) {
  return claimedBy?.split(",").includes("workbench-cli.thread-status") ?? false;
}

function semanticMatcherResult(ongoing: string, completed: string) {
  return CommandMatcher.Result({
    ongoingSummaryParts: [CommandMatcher.Text(ongoing)],
    remainingCommand: null,
    stop: true,
    summaryParts: [CommandMatcher.Text(completed)],
  });
}

function hiddenCommandResult(ongoing: string, completed: string) {
  return CommandMatcher.Result({
    hideCommandCwd: true,
    hideCommandOutput: true,
    ongoingSummaryParts: [CommandMatcher.Text(ongoing)],
    remainingCommand: null,
    stop: true,
    summaryParts: [CommandMatcher.Text(completed)],
  });
}

function subagentCountLabel(count: number) {
  return count === 1 ? "subagent" : `${count} subagents`;
}

function renderSubagentCliFallback(command: WorkbenchSubagentCommand) {
  const countLabel = subagentCountLabel(command.targets.length);
  switch (command.action) {
    case "create": return semanticMatcherResult("Creating subagent", "Created subagent");
    case "message": return command.toParent
      ? semanticMatcherResult("Messaging parent", "Messaged parent")
      : semanticMatcherResult("Messaging subagent", "Messaged subagent");
    case "settle": return semanticMatcherResult(`Settling ${countLabel}`, `Settled ${countLabel}`);
    case "stop": return semanticMatcherResult(`Stopping ${countLabel}`, `Stopped ${countLabel}`);
    case "wait": return semanticMatcherResult(`Waiting for ${countLabel}`, `Waited for ${countLabel}`);
    case "list":
    case "profiles":
      return getWorkbenchCommandRendering(`subagent_${command.action}`, {})?.result ?? null;
  }
}

export const WORKBENCH_CLI_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-cli.thread-status",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadStatusCommand(stage.text);
      if (summaryParts.length || !command) return null;
      return command.status === "completed"
        ? semanticMatcherResult("Marking task completed", "Task completed")
        : semanticMatcherResult("Marking task blocked", "Task blocked");
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-title-set",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "set") return null;
      return getWorkbenchCommandRendering("thread_title", { title: command.title })?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-title-get",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "get") return null;
      return getWorkbenchCommandRendering("thread_title_get", {})?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-resume",
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length || !/^wb(?:\.cmd)?\s+thread\s+resume(?:\s|$)/iu.test(stage.text.trim())) return null;
      return getWorkbenchCommandRendering("thread_resume", {})?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.reload",
    match: ({ stage }) => {
      const normalized = stage.text.trim();
      if (!/^wb(?:\.cmd)?\s+reload(?:\s|$)/iu.test(normalized)) return null;
      const selections = [...normalized.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\+[a-z][a-z0-9-]*)*)(?=\s|$)/gu)]
        .map((match) => match[1]);
      const label = /(?:^|\s)--hard(?:\s|$)/u.test(normalized)
        ? "Workbench process"
        : selections.length ? selections.join(", ") : "dirty Workbench scopes";
      return hiddenCommandResult(`Reloading ${label}`, `Reloaded ${label}`);
    },
  }),
  CommandMatcher({
    id: "workbench-cli.dirt",
    match: ({ stage, summaryParts }) => summaryParts.length || !/^wb(?:\.cmd)?\s+dirt(?:\s|$)/iu.test(stage.text.trim())
      ? null
      : hiddenCommandResult("Checking reload dirt", "Checked reload dirt"),
  }),
  CommandMatcher({
    id: "workbench-cli.subagent",
    match: ({ stage }) => {
      const command = parseWorkbenchSubagentCommand(stage.text);
      if (!command) return null;
      return renderSubagentCliFallback(command);
    },
  }),
];
