/*
 * Exports:
 * - WorkbenchInstructionTool: a Workbench tool an agent can use, with its MCP exposure and code-mode eligibility.
 * - listWorkbenchInstructionTools: the instruction catalogue for command definitions, including deferred and capability-gated commands.
 * - selectWorkbenchInstructionTools: the catalogue one caller's `<docs>` gates and tool references see.
 * - resolveWorkbenchInstructionToolReference: format a preloaded MCP tool for one provider's instruction payload.
 * - listWorkbenchInstructionToolFamily: catalogued ids a `<docs>` gate id covers, itself and its `id_*` subtools.
 * - servesWorkbenchInstructionTool: whether an agent can use a tool or any of its `id_*` subtools, through MCP or CLI, for `<docs>` gates.
 */
import type { WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { WORKBENCH_SHELL_MCP_TOOL_NAME } from "workbench-shared/workbench/commands/workbench-shell-command";
import {
  getWorkbenchAgentCommandToolName,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchCommandAudienceRule,
} from "../commands/workbench-agent-command-definition";
import { refuseWorkbenchTool, type WorkbenchCommandAudience } from "../commands/workbench-command-audience";

/** Carries its command's audience rule, so catalogue readers apply the same visibility as MCP and CLI. */
export interface WorkbenchInstructionTool extends WorkbenchCommandAudienceRule {
  readonly id: string;
  readonly codeModeEligible: boolean;
  /** Not preloaded: reached through the `wb` CLI or `mcp_call` on server `wb`, so no direct MCP name exists to reference. */
  readonly deferred?: boolean;
}

export function listWorkbenchInstructionTools(definitions: readonly WorkbenchAgentCommandDefinition[]): WorkbenchInstructionTool[] {
  return [
    { id: WORKBENCH_SHELL_MCP_TOOL_NAME, codeModeEligible: true },
    ...definitions.map(definition => ({
      id: getWorkbenchAgentCommandToolName(definition),
      codeModeEligible: definition.mcpCodeModeEligible === true,
      ...(definition.mcpDeferred ? { deferred: true } : {}),
      ...(definition.audience?.harnesses ? { harnesses: definition.audience.harnesses } : {}),
      ...(definition.audience?.rootOnly ? { rootOnly: true as const } : {}),
      ...(definition.audience?.requiresCapability ? { requiresCapability: definition.audience.requiresCapability } : {}),
    })),
  ];
}

/** Prompt context does not know the Workbench root, so root-only tools keep their docs. */
export function selectWorkbenchInstructionTools(
  catalogue: readonly WorkbenchInstructionTool[],
  caller: Pick<WorkbenchCommandAudience, "harness" | "subagent">,
  capabilities: WorkbenchLocalCapabilitySettings,
) {
  const audience = { ...caller, workbenchRoot: true, capabilities };
  return catalogue.filter(tool => refuseWorkbenchTool(tool.id, tool, audience) === null);
}

export function resolveWorkbenchInstructionToolReference(
  id: string,
  harness: WorkbenchHarness,
  catalogue: readonly WorkbenchInstructionTool[],
): string | null {
  const tool = catalogue.find(candidate => candidate.id === id);
  if (!tool || tool.deferred) return null;
  if (harness === "codex") {
    const namespace = tool.codeModeEligible ? "wb" : "wbex";
    return `tools.mcp__${namespace}__${id}`;
  }
  if (harness === "opencode") return tool.codeModeEligible ? `tools.wb.${id}` : `wbex_${id}`;
  if (harness === "claude") return `mcp__wb__${id}`;
  return null;
}

export function listWorkbenchInstructionToolFamily(id: string, catalogue: readonly WorkbenchInstructionTool[]) {
  return catalogue.filter(tool => tool.id === id || tool.id.startsWith(`${id}_`)).map(tool => tool.id);
}

export function servesWorkbenchInstructionTool(id: string, catalogue: readonly WorkbenchInstructionTool[]) {
  return listWorkbenchInstructionToolFamily(id, catalogue).length > 0;
}
