/*
 * Exports:
 * - WorkbenchCommandAudience: the caller facts that decide which commands it may use.
 * - WorkbenchCommandRefusal: why a command is withheld from one audience.
 * - refuseWorkbenchTool: the one visibility rule shared by MCP listing, MCP admission, CLI and the instruction catalogue.
 * - refuseWorkbenchCommand: the same rule applied to a command definition.
 * - refuseWorkbenchCommandCaller: the rule for one call, reading the caller's subagent role only when it matters.
 */
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
}

export type WorkbenchCommandRefusal = "harness" | "parentOnly" | "rootOnly";

/** Null when the audience may use the tool. */
export function refuseWorkbenchTool(
  toolName: string,
  { harnesses, rootOnly }: WorkbenchCommandAudienceRule = {},
  { harness, subagent, workbenchRoot }: WorkbenchCommandAudience,
): WorkbenchCommandRefusal | null {
  if (harnesses && !harnesses.some(candidate => candidate === harness)) return "harness";
  if (!isWorkbenchToolVisibleTo(toolName, subagent)) return "parentOnly";
  if (rootOnly && !workbenchRoot) return "rootOnly";
  return null;
}

export function refuseWorkbenchCommand(
  definition: Pick<WorkbenchAgentCommandDefinition, "audience" | "words">,
  audience: WorkbenchCommandAudience,
) {
  return refuseWorkbenchTool(getWorkbenchAgentCommandToolName(definition), definition.audience, audience);
}

/** For call admission: whether the caller is a subagent is read only for parent-only commands, since that read can fail. */
export async function refuseWorkbenchCommandCaller(
  definition: Pick<WorkbenchAgentCommandDefinition, "audience" | "words">,
  caller: Omit<WorkbenchCommandAudience, "subagent">,
  isSubagent: () => Promise<boolean>,
) {
  const asParent = refuseWorkbenchCommand(definition, { ...caller, subagent: false });
  if (asParent) return asParent;
  return refuseWorkbenchCommand(definition, { ...caller, subagent: true }) && await isSubagent() ? "parentOnly" : null;
}
