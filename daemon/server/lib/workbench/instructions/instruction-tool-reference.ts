/*
 * Exports:
 * - WorkbenchInstructionTool: registered MCP tool identity and Codex code-mode eligibility.
 * - resolveWorkbenchInstructionToolReference: format a catalogued Workbench tool for one provider's instruction payload.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export interface WorkbenchInstructionTool {
  readonly id: string;
  readonly codeModeEligible: boolean;
}

export function resolveWorkbenchInstructionToolReference(
  id: string,
  harness: WorkbenchHarness,
  catalogue: readonly WorkbenchInstructionTool[],
): string | null {
  const tool = catalogue.find(candidate => candidate.id === id);
  if (!tool) return null;
  if (harness === "codex") {
    const namespace = tool.codeModeEligible ? "wb" : "wbex";
    return `tools.mcp__${namespace}__${id}`;
  }
  if (harness === "opencode") return `tools.wb.${id}`;
  return null;
}
