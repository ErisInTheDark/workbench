/*
 * Exports:
 * - WorkbenchMessageCommand/parseWorkbenchMessageCommand: parse canonical and legacy global thread messages.
 * - WorkbenchSubagentCommand/WorkbenchSubagentCommandTarget/parseWorkbenchSubagentCommand: parse semantic subagent actions, create metadata, and ordered id/name targets.
 * - WorkbenchTaskTitleCommand/parseWorkbenchTaskTitleCommand/isWorkbenchTaskTitleSetMatcherClaim: parse task title actions and identify standalone title-set displays.
 * - WorkbenchTaskStatusCommand/parseWorkbenchTaskStatusCommand/isWorkbenchTaskStatusMatcherClaim: parse task completion actions and identify standalone successful displays.
 * - WORKBENCH_CLI_COMMAND_MATCHERS: shell-neutral matchers for wb toc, task, token, subagent, and reload commands.
 */
import type { CommandAction } from "workbench-shared/workbench/thread/workbench-thread-items";

import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";
import { getWorkbenchCommandRendering } from "./workbench-command-rendering";

export type WorkbenchSubagentCommandAction = "create" | "list" | "profiles" | "settle" | "stop" | "wait";

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
}

export interface WorkbenchMessageCommand {
  message: string;
  target: { kind: "name" | "parent" | "thread"; value: string | null };
}

export type WorkbenchTaskTitleCommand =
  | { action: "get" }
  | { action: "set"; title: string };

export interface WorkbenchTaskStatusCommand {
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
  const actionMatch = normalized.match(/^wb(?:\.cmd)?\s+subagent\s+(list|profiles|create|wait|stop|settle)\b/iu);
  if (!actionMatch) return null;
  const action = actionMatch[1].toLowerCase() as WorkbenchSubagentCommandAction;
  return {
    action,
    message: readFlagValue(normalized, "message"),
    name: action === "create" ? readFlagValue(normalized, "name") : null,
    profileId: readFlagValue(normalized, "profile"),
    targets: action === "settle" || action === "stop" || action === "wait"
      ? readSubagentTargets(normalized)
      : [],
    title: readFlagValue(normalized, "title"),
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

function parseSingleWorkbenchMessageCommand(command: string): WorkbenchMessageCommand | null {
  const normalized = command.trim();
  const legacy = /^wb(?:\.cmd)?\s+subagent\s+message\b/iu.test(normalized);
  if (!legacy && !/^wb(?:\.cmd)?\s+message\b/iu.test(normalized)) return null;
  const message = readFlagValue(normalized, "message");
  if (!message) return null;
  const name = readFlagValue(normalized, "name");
  const threadId = readFlagValue(normalized, legacy ? "id" : "thread");
  const parent = hasBooleanFlag(normalized, "parent");
  if ([Boolean(name), Boolean(threadId), parent].filter(Boolean).length !== 1) return null;
  return {
    message,
    target: parent
      ? { kind: "parent", value: null }
      : name
        ? { kind: "name", value: name }
        : { kind: "thread", value: threadId },
  };
}

export function parseWorkbenchMessageCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchMessageCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchMessageCommand(action.command);
    if (parsedAction) return parsedAction;
  }
  return parseSingleWorkbenchMessageCommand(command);
}

function parseSingleWorkbenchTaskTitleCommand(command: string): WorkbenchTaskTitleCommand | null {
  const normalized = command.trim();
  if (/^wb(?:\.cmd)?\s+task\s+get\s*$/iu.test(normalized)) return { action: "get" };
  if (!/^wb(?:\.cmd)?\s+task\s+set(?:\s|$)/iu.test(normalized)) return null;
  const title = readFlagValue(normalized, "title");
  return title ? { action: "set", title } : null;
}

export function parseWorkbenchTaskTitleCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchTaskTitleCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchTaskTitleCommand(action.command);
    if (parsedAction) return parsedAction;
  }
  return parseSingleWorkbenchTaskTitleCommand(command);
}

export function isWorkbenchTaskTitleSetMatcherClaim(claimedBy: string | null | undefined) {
  return claimedBy?.split(",").includes("workbench-cli.task-title-set") ?? false;
}

function parseSingleWorkbenchTaskStatusCommand(command: string): WorkbenchTaskStatusCommand | null {
  const normalized = command.trim();
  const match = /^wb(?:\.cmd)?\s+task\s+(completed|blocked)\s*$/iu.exec(normalized);
  return match ? { status: match[1]!.toLowerCase() as WorkbenchTaskStatusCommand["status"] } : null;
}

export function parseWorkbenchTaskStatusCommand(
  command: string,
  commandActions: readonly CommandAction[] = [],
): WorkbenchTaskStatusCommand | null {
  for (const action of commandActions) {
    const parsedAction = parseSingleWorkbenchTaskStatusCommand(action.command);
    if (parsedAction) return parsedAction;
  }
  return parseSingleWorkbenchTaskStatusCommand(command);
}

export function isWorkbenchTaskStatusMatcherClaim(claimedBy: string | null | undefined) {
  return claimedBy?.split(",").includes("workbench-cli.task-status") ?? false;
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
    id: "workbench-cli.toc",
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length) return null;
      const normalized = stage.text.trim();
      const commandMatch = /^wb(?:\.cmd)?\s+toc(?:\s+|$)/iu.exec(normalized);
      if (!commandMatch) return null;
      const file = readValue(normalized, commandMatch[0].length).value;
      return file && file !== "--help"
        ? getWorkbenchCommandRendering("toc", { file })?.result ?? null
        : null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.tokens",
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length) return null;
      const normalized = stage.text.trim();
      if (/^wb(?:\.cmd)?\s+tokens\s+instructions(?:\s|$)/iu.test(normalized)) {
        return getWorkbenchCommandRendering("tokens_instructions", {})?.result ?? null;
      }
      if (/^wb(?:\.cmd)?\s+tokens\s+project(?:\s|$)/iu.test(normalized)) {
        return getWorkbenchCommandRendering("tokens_project", {})?.result ?? null;
      }
      if (/^wb(?:\.cmd)?\s+tokens(?:\s|$)/iu.test(normalized)) {
        return getWorkbenchCommandRendering("tokens", {})?.result ?? null;
      }
      return null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.task-status",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchTaskStatusCommand(stage.text);
      if (summaryParts.length || !command) return null;
      return command.status === "completed"
        ? semanticMatcherResult("Marking task completed", "Task completed")
        : semanticMatcherResult("Marking task blocked", "Task blocked");
    },
  }),
  CommandMatcher({
    id: "workbench-cli.task-title-set",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchTaskTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "set") return null;
      return getWorkbenchCommandRendering("task_set", { title: command.title })?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.task-title-get",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchTaskTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "get") return null;
      return getWorkbenchCommandRendering("task_get", {})?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-refresh",
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length || !/^wb(?:\.cmd)?\s+thread\s+refresh(?:\s|$)/iu.test(stage.text.trim())) return null;
      return getWorkbenchCommandRendering("thread_refresh", {})?.result ?? null;
    },
  }),
  CommandMatcher({
    id: "workbench-cli.reload",
    match: ({ stage }) => {
      const normalized = stage.text.trim();
      if (
        !/^wb(?:\.cmd)?\s+reload(?:\s|$)/iu.test(normalized)
        || /(?:^|\s)--help(?=\s|$)/iu.test(normalized)
      ) return null;
      const selections = [...normalized.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*(?:\+[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)*)(?=\s|$)/gu)]
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
    id: "workbench-cli.message",
    match: ({ stage }) => {
      const command = parseWorkbenchMessageCommand(stage.text);
      if (!command) return null;
      const target = command.target.kind === "parent" ? "parent"
        : command.target.kind === "name" ? "subagent"
          : "thread";
      return semanticMatcherResult(`Messaging ${target}`, `Messaged ${target}`);
    },
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
