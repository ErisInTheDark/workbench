/*
 * Exports:
 * - WORKBENCH_AGENT_COMMANDS/listWorkbenchAgentCommands: canonical typed wb command registry assembled from focused command families. Keywords: workbench, commands, registry, MCP, CLI.
 */
import { WORKBENCH_BROWSE_COMMANDS } from "./browse-command-definitions";
import { WORKBENCH_GIT_ARC_COMMANDS } from "./git-arc-command-definitions";
import { WORKBENCH_GIT_COMMANDS } from "./git-command-definitions";
import { WORKBENCH_ORCHESTRATOR_COMMANDS } from "./orchestrator-command-definitions";
import { WORKBENCH_SUBAGENT_COMMANDS } from "./subagent-command-definitions";
import { WORKBENCH_THREAD_COMMANDS } from "./thread-command-definitions";
import type { WorkbenchAgentCommandDefinition } from "./workbench-agent-command-definition";

export const WORKBENCH_AGENT_COMMANDS: readonly WorkbenchAgentCommandDefinition[] = Object.freeze([
  ...WORKBENCH_SUBAGENT_COMMANDS,
  ...WORKBENCH_THREAD_COMMANDS,
  ...WORKBENCH_GIT_COMMANDS,
  ...WORKBENCH_GIT_ARC_COMMANDS,
  ...WORKBENCH_BROWSE_COMMANDS,
  ...WORKBENCH_ORCHESTRATOR_COMMANDS,
]);

export function listWorkbenchAgentCommands() {
  return WORKBENCH_AGENT_COMMANDS;
}
