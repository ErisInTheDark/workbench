/*
 * Exports:
 * - WORKBENCH_CLI_COMMAND_MATCHERS: shell-neutral matchers for wb title and Collaboration commands. Keywords: workbench, cli, title, collaboration.
 */
import { CommandMatcher } from "./core";
import type { CommandMatcherDefinition } from "./types";

const WB_PREFIX = /^wb(?:\.cmd)?\s+/iu;

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
