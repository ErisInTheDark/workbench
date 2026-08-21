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

export const WORKBENCH_CLI_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-cli.thread-status",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadStatusCommand(stage.text);
      if (summaryParts.length || !command) return null;
      const completed = command.status === "completed";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(completed ? "Marking task completed" : "Marking task blocked")],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(completed ? "Task completed" : "Task blocked")],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-title-set",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "set") return null;
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(`Setting task: ${command.title}`)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(`Task: ${command.title}`)],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.thread-title-get",
    match: ({ stage, summaryParts }) => {
      const command = parseSingleWorkbenchThreadTitleCommand(stage.text);
      if (summaryParts.length || command?.action !== "get") return null;
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text("Checking thread title")],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text("Checked thread title")],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.orchestrator-reload",
    match: ({ stage }) => {
      const normalized = stage.text.trim();
      if (!/^wb(?:\.cmd)?\s+orchestrator\s+reload(?:\s|$)/iu.test(normalized)) {
        return null;
      }
      const scopes = ["orchestrator-logic", "browse-controller", "codex-bridge", "opencode-bridge", "opencode-server", "next-dev"]
        .filter((scope) => new RegExp(`(?:^|\\s)--${scope}(?:\\s|$)`, "u").test(normalized));
      const label = /(?:^|\s)--hard(?:\s|$)/u.test(normalized)
        ? "orchestrator server"
        : /(?:^|\s)--all(?:\s|$)/u.test(normalized)
          ? scopes.length ? scopes.join(", ") : "all reloadable scopes"
          : scopes.length ? scopes.join(", ") : "orchestrator";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(`${label === "orchestrator server" ? "Restarting" : "Reloading"} ${label}`)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(`${label === "orchestrator server" ? "Restarted" : "Reloaded"} ${label}`)],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.subagent",
    match: ({ stage }) => {
      const command = parseWorkbenchSubagentCommand(stage.text);
      if (!command) return null;
      const targetCount = command.targets.length;
      const labels: Record<Exclude<WorkbenchSubagentCommandAction, "settle" | "stop" | "wait">, string> = {
        create: "Created subagent",
        list: "Listed subagents",
        message: "Messaged subagent",
        profiles: "Listed subagent profiles",
      };
      const label = command.action === "message" && command.toParent
        ? "Messaged parent"
        : command.action === "wait"
        ? targetCount > 1 ? `Waited for ${targetCount} subagents` : "Waited for subagent"
        : command.action === "stop"
        ? targetCount > 1 ? `Stopped ${targetCount} subagents` : "Stopped subagent"
        : command.action === "settle"
        ? targetCount > 1 ? `Settled ${targetCount} subagents` : "Settled subagent"
        : labels[command.action];
      const ongoingLabel = command.action === "message" && command.toParent
        ? "Messaging parent"
        : command.action === "wait"
        ? targetCount > 1 ? `Waiting for ${targetCount} subagents` : "Waiting for subagent"
        : command.action === "create" ? "Creating subagent"
        : command.action === "list" ? "Listing subagents"
        : command.action === "message" ? "Messaging subagent"
        : command.action === "profiles" ? "Listing subagent profiles"
        : command.action === "settle"
        ? targetCount > 1 ? `Settling ${targetCount} subagents` : "Settling subagent"
        : targetCount > 1 ? `Stopping ${targetCount} subagents` : "Stopping subagent";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(ongoingLabel)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(label)],
      });
    },
  }),
];
