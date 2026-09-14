/*
 * Exports:
 * - listWorkbenchAgentCommands: assemble canonical typed wb commands with reload definitions from the active topology catalog.
 * - listWorkbenchAgentCodeModeToolNames: list the explicit default-deny subset safe for nested Code Mode calls.
 */
import { WORKBENCH_BROWSE_COMMANDS } from "./browse-command-definitions";
import { WORKBENCH_GIT_ARC_COMMANDS } from "./git-arc-command-definitions";
import { WORKBENCH_GIT_COMMANDS } from "./git-command-definitions";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import { WORKBENCH_QUESTIONNAIRE_COMMANDS } from "./questionnaire-command-definition";
import { createWorkbenchReloadCommands } from "./reload-command-definitions";
import { WORKBENCH_RIPGREP_COMMANDS } from "./ripgrep-command-definition";
import { WORKBENCH_SUBAGENT_COMMANDS } from "./subagent-command-definitions";
import { WORKBENCH_THREAD_COMMANDS } from "./thread-command-definitions";
import { WORKBENCH_TOKEN_COMMANDS } from "./token-command-definition";
import { WORKBENCH_TRANSCRIPT_COMMANDS } from "./transcript-command-definitions";
import { WORKBENCH_TOC_COMMANDS } from "./toc-command-definition";
import { WORKBENCH_STATS_COMMANDS } from "./stats-command-definitions";
import {
  getWorkbenchAgentCommandToolName,
  type WorkbenchAgentCommandDefinition,
} from "./workbench-agent-command-definition";

const WORKBENCH_AGENT_COMMANDS: readonly WorkbenchAgentCommandDefinition[] = Object.freeze([
  ...WORKBENCH_TOC_COMMANDS,
  ...WORKBENCH_STATS_COMMANDS,
  ...WORKBENCH_RIPGREP_COMMANDS,
  ...WORKBENCH_QUESTIONNAIRE_COMMANDS,
  ...WORKBENCH_SUBAGENT_COMMANDS,
  ...WORKBENCH_THREAD_COMMANDS,
  ...WORKBENCH_TOKEN_COMMANDS,
  ...WORKBENCH_TRANSCRIPT_COMMANDS,
  ...WORKBENCH_GIT_COMMANDS,
  ...WORKBENCH_GIT_ARC_COMMANDS,
  ...WORKBENCH_BROWSE_COMMANDS,
]);

export function listWorkbenchAgentCommands(
  catalog: readonly DaemonReloadScopeDescriptor[] = [],
  access: DaemonReloadScopeDescriptor["access"] = "agent",
) {
  return [...WORKBENCH_AGENT_COMMANDS, ...createWorkbenchReloadCommands(catalog, access)];
}

export function listWorkbenchAgentCodeModeToolNames() {
  return WORKBENCH_AGENT_COMMANDS
    .filter(({ hideFromMcp, mcpCodeModeEligible }) => mcpCodeModeEligible && !hideFromMcp)
    .map(getWorkbenchAgentCommandToolName)
    .sort();
}
