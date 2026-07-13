/*
 * Exports:
 * - WorkbenchSubagentCommand/parseWorkbenchSubagentCommand: parse semantic subagent action, child thread ID, and message from wb commands. Keywords: workbench, cli, subagent, parse, thread id, message.
 * - WORKBENCH_CLI_COMMAND_MATCHERS: shell-neutral matchers for wb title, subagent, reload, and Collaboration commands. Keywords: workbench, cli, title, subagent, collaboration.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const WB_PREFIX = /^wb(?:\.cmd)?\s+/iu;

export type WorkbenchSubagentCommandAction = "create" | "message" | "profiles" | "stop" | "wait";

export interface WorkbenchSubagentCommand {
  action: WorkbenchSubagentCommandAction;
  message: string | null;
  threadId: string | null;
}

function readFlagValue(command: string, flag: string) {
  const match = new RegExp(`(?:^|\\s)--${flag}(?:\\s+|=)`, "u").exec(command);
  if (!match) return null;
  let index = match.index + match[0].length;
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
        return value;
      }
      if ((character === "\\" || character === "`") && command[index + 1] === quote) {
        value += quote;
        index += 2;
        continue;
      }
    } else if (/\s|[;&|]/u.test(character)) {
      return value;
    }
    value += character;
    index += 1;
  }

  return value || null;
}

export function parseWorkbenchSubagentCommand(command: string): WorkbenchSubagentCommand | null {
  const normalized = command.trim();
  const actionMatch = normalized.match(/^wb(?:\.cmd)?\s+subagent\s+(profiles|create|wait|message|stop)\b/iu);
  if (!actionMatch) return null;
  const action = actionMatch[1].toLowerCase() as WorkbenchSubagentCommandAction;
  return {
    action,
    message: readFlagValue(normalized, "message"),
    threadId: readFlagValue(normalized, "id"),
  };
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
      const scopes = ["orchestrator-logic", "codex-bridge", "opencode-bridge", "opencode-server", "next-dev"]
        .filter((scope) => new RegExp(`(?:^|\\s)--${scope}(?:\\s|$)`, "u").test(normalized));
      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(`Reloaded ${scopes.length ? scopes.join(", ") : "orchestrator"}`)],
      });
    },
  }),
  CommandMatcher({
    id: "workbench-cli.subagent",
    match: ({ stage }) => {
      const command = parseWorkbenchSubagentCommand(stage.text);
      if (!command) return null;
      const labels: Record<WorkbenchSubagentCommandAction, string> = {
        create: "Created subagent",
        message: "Messaged subagent",
        profiles: "Listed subagent profiles",
        stop: "Stopped subagent",
        wait: "Waited for subagent",
      };
      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(labels[command.action])],
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
      return CommandMatcher.Result({
        remainingCommand: null,
        stop: true,
        summaryParts: [CommandMatcher.Text(`${verb} ${owner.toLowerCase()}`)],
      });
    },
  }),
];
