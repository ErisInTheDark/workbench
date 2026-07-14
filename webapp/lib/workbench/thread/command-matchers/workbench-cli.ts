/*
 * Exports:
 * - WorkbenchSubagentCommand/parseWorkbenchSubagentCommand: parse semantic subagent actions, create metadata, ordered child thread IDs, and messages from wb commands. Keywords: workbench, cli, subagent, parse, create, metadata, thread ids, message.
 * - WORKBENCH_CLI_COMMAND_MATCHERS: shell-neutral matchers for wb title, subagent, reload, and Collaboration commands. Keywords: workbench, cli, title, subagent, collaboration.
 */
import type { CommandAction } from "../../../codex/generated/app-server/v2/CommandAction";

import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const WB_PREFIX = /^wb(?:\.cmd)?\s+/iu;

export type WorkbenchSubagentCommandAction = "create" | "list" | "message" | "profiles" | "stop" | "wait";

export interface WorkbenchSubagentCommand {
  action: WorkbenchSubagentCommandAction;
  message: string | null;
  name: string | null;
  profileId: string | null;
  threadIds: string[];
  title: string | null;
}

function readValue(command: string, startIndex: number) {
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
      if ((character === "\\" || character === "`") && command[index + 1] === quote) {
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

function parseSingleWorkbenchSubagentCommand(command: string): WorkbenchSubagentCommand | null {
  const normalized = command.trim();
  const actionMatch = normalized.match(/^wb(?:\.cmd)?\s+subagent\s+(list|profiles|create|wait|message|stop)\b/iu);
  if (!actionMatch) return null;
  const action = actionMatch[1].toLowerCase() as WorkbenchSubagentCommandAction;
  return {
    action,
    message: readFlagValue(normalized, "message"),
    name: readFlagValue(normalized, "name"),
    profileId: readFlagValue(normalized, "profile"),
    threadIds: readFlagValues(normalized, "id"),
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

export const WORKBENCH_CLI_COMMAND_MATCHERS: CommandMatcherDefinition[] = [
  CommandMatcher({
    id: "workbench-cli.thread-title",
    match: ({ stage, summaryParts }) => {
      if (summaryParts.length || !/^wb(?:\.cmd)?\s+thread\s+title(?:\s|$)/iu.test(stage.text.trim())) {
        return null;
      }
      return CommandMatcher.Result({
        hide: true,
        omitFromDisplay: true,
        ongoingSummaryParts: [],
        remainingCommand: null,
        stop: true,
        summaryParts: [],
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
      const labels: Record<Exclude<WorkbenchSubagentCommandAction, "wait">, string> = {
        create: "Created subagent",
        list: "Listed subagents",
        message: "Messaged subagent",
        profiles: "Listed subagent profiles",
        stop: "Stopped subagent",
      };
      const label = command.action === "wait"
        ? command.threadIds.length > 1 ? `Waited for ${command.threadIds.length} subagents` : "Waited for subagent"
        : labels[command.action];
      const ongoingLabel = command.action === "wait"
        ? command.threadIds.length > 1 ? `Waiting for ${command.threadIds.length} subagents` : "Waiting for subagent"
        : command.action === "create" ? "Creating subagent"
        : command.action === "list" ? "Listing subagents"
        : command.action === "message" ? "Messaging subagent"
        : command.action === "profiles" ? "Listing subagent profiles"
        : "Stopping subagent";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(ongoingLabel)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(label)],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.collaboration",
    match: ({ stage }) => {
      const normalized = stage.text.trim();
      if (!WB_PREFIX.test(normalized) || !/^wb(?:\.cmd)?\s+collaboration\s+/iu.test(normalized)) {
        return null;
      }
      const action = normalized.match(/^wb(?:\.cmd)?\s+collaboration\s+(posts|memory)\s+(read|create|update|delete|write)\b/iu);
      if (!action) {
        return null;
      }
      const owner = action[1] === "posts" ? "Collaboration posts" : "Collaboration memory";
      const verb = action[2] === "read" ? "Read"
        : action[2] === "create" ? "Created"
        : action[2] === "update" ? "Updated"
        : action[2] === "delete" ? "Deleted"
        : "Updated";
      const ongoingVerb = action[2] === "read" ? "Reading"
        : action[2] === "create" ? "Creating"
        : action[2] === "delete" ? "Deleting"
        : "Updating";
      return CommandMatcher.Result({
        ongoingSummaryParts: [CommandMatcher.Text(`${ongoingVerb} ${owner.toLowerCase()}`)],
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(`${verb} ${owner.toLowerCase()}`)],
      });
    },
  }),
];
