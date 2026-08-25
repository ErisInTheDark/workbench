/*
 * Exports:
 * - listWorkbenchAgentCommands: assemble canonical typed wb commands with reload definitions from the active topology catalog. Keywords: workbench, commands, registry, MCP, CLI.
 */
import { WORKBENCH_BROWSE_COMMANDS } from "./browse-command-definitions";
import { WORKBENCH_GIT_ARC_COMMANDS } from "./git-arc-command-definitions";
import { WORKBENCH_GIT_COMMANDS } from "./git-command-definitions";
import type { OrchestratorReloadScopeDescriptor } from "../orchestrator-reload";
import { createWorkbenchOrchestratorCommands } from "./orchestrator-command-definitions";
import { WORKBENCH_SUBAGENT_COMMANDS } from "./subagent-command-definitions";
import { WORKBENCH_THREAD_COMMANDS } from "./thread-command-definitions";
import type { WorkbenchAgentCommandDefinition } from "./workbench-agent-command-definition";

const WORKBENCH_AGENT_COMMANDS: readonly WorkbenchAgentCommandDefinition[] = Object.freeze([
  ...WORKBENCH_SUBAGENT_COMMANDS,
  ...WORKBENCH_THREAD_COMMANDS,
  ...WORKBENCH_GIT_COMMANDS,
  ...WORKBENCH_GIT_ARC_COMMANDS,
  ...WORKBENCH_BROWSE_COMMANDS,
]);

export function listWorkbenchAgentCommands(
  catalog: readonly OrchestratorReloadScopeDescriptor[] = [],
  access: OrchestratorReloadScopeDescriptor["access"] = "agent",
) {
  return [...WORKBENCH_AGENT_COMMANDS, ...createWorkbenchOrchestratorCommands(catalog, access)];
}
