/*
 * Exports:
 * - WorkbenchCommandAudience: the caller facts that decide which commands it may use.
 * - WorkbenchCommandRefusal: why a command is withheld from one audience.
 * - refuseWorkbenchTool: the one visibility rule shared by MCP listing, MCP admission, CLI and the instruction catalogue.
 * - refuseWorkbenchCommand: the same rule applied to a command definition.
 * - refuseWorkbenchCommandCaller: the rule for one call, reading the caller's subagent role and local capabilities only when they matter.
 * - describeWorkbenchCommandRefusal: the agent-facing explanation of one refusal, shared by MCP and CLI.
 */
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { isWorkbenchToolVisibleTo } from "workbench-shared/workbench/commands/workbench-tool-audience";
import {
  getWorkbenchAgentCommandToolName,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchCommandAudienceRule,
} from "./workbench-agent-command-definition";

export interface WorkbenchCommandAudience {
  harness: string;
  subagent: boolean;
  /** A managed thread at the Workbench repository root, or an unmanaged caller. */
  workbenchRoot: boolean;
  /** Null when unknown here: capability gates are left to per-call admission. */
  capabilities: WorkbenchLocalCapabilitySettings | null;
}

export type WorkbenchCommandRefusal = "harness" | "parentOnly" | "rootOnly" | "capability";

/** Null when the audience may use the tool. */
export function refuseWorkbenchTool(
  toolName: string,
  { harnesses, rootOnly, requiresCapability }: WorkbenchCommandAudienceRule = {},
  { harness, subagent, workbenchRoot, capabilities }: WorkbenchCommandAudience,
): WorkbenchCommandRefusal | null {
  if (harnesses && !harnesses.some(candidate => candidate === harness)) return "harness";
  if (!isWorkbenchToolVisibleTo(toolName, subagent)) return "parentOnly";
  if (rootOnly && !workbenchRoot) return "rootOnly";
  if (requiresCapability && capabilities && !capabilities[requiresCapability]) return "capability";
  return null;
}

export function refuseWorkbenchCommand(
  definition: Pick<WorkbenchAgentCommandDefinition, "audience" | "words">,
  audience: WorkbenchCommandAudience,
) {
  return refuseWorkbenchTool(getWorkbenchAgentCommandToolName(definition), definition.audience, audience);
}

/** For call admission: the subagent role and local capabilities are read only for commands they gate, since reads can fail. */
export async function refuseWorkbenchCommandCaller(
  definition: Pick<WorkbenchAgentCommandDefinition, "audience" | "words">,
  caller: Omit<WorkbenchCommandAudience, "subagent" | "capabilities">,
  { isSubagent, readCapabilities }: {
    isSubagent: () => Promise<boolean>;
    readCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>;
  },
) {
  const asParent = refuseWorkbenchCommand(definition, { ...caller, subagent: false, capabilities: null });
  if (asParent) return asParent;
  if (refuseWorkbenchCommand(definition, { ...caller, subagent: true, capabilities: null }) && await isSubagent()) return "parentOnly";
  if (!definition.audience?.requiresCapability) return null;
  return refuseWorkbenchCommand(definition, { ...caller, subagent: false, capabilities: await readCapabilities() });
}

const REFUSAL_TEXT: Record<WorkbenchCommandRefusal, (toolName: string, harness: string) => string> = {
  harness: (toolName, harness) => `${toolName} is not available to ${harness} agents.`,
  parentOnly: toolName => `${toolName} belongs to the parent thread; subagents leave claims for parent adoption and report to the parent.`,
  rootOnly: toolName => `${toolName} is available only to threads at the Workbench repository root.`,
  capability: toolName => `${toolName} is turned off in Workbench Settings; ask the user to enable it.`,
};

export function describeWorkbenchCommandRefusal(refusal: WorkbenchCommandRefusal, toolName: string, harness: string) {
  return REFUSAL_TEXT[refusal](toolName, harness);
}
