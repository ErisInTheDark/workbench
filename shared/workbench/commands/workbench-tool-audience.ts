/*
 * Exports:
 * - WORKBENCH_PARENT_ONLY_TOOLS: tools whose work belongs to the coordinating parent.
 * - isWorkbenchAgentCliOpenTo: whether a managed agent may use the wb CLI for a command its MCP server also offers.
 * - isWorkbenchToolVisibleTo: select tools for parent or subagent presentation and admission.
 * - WORKBENCH_CODE_MODE_TOOL_META/isWorkbenchCodeModeTool: MCP tool `_meta` marking tools served nested in provider code mode rather than directly.
 */
import type { WorkbenchProviderKey } from "../provider/provider-registrations";

export const WORKBENCH_CODE_MODE_TOOL_META = Object.freeze({ "workbench/codeMode": true });

export function isWorkbenchCodeModeTool(meta: Record<string, unknown> | undefined) {
  return meta?.["workbench/codeMode"] === true;
}

// Parents own child lifecycle, proposal, and title operations.
export const WORKBENCH_PARENT_ONLY_TOOLS: readonly string[] = [
  "git_arc_propose",
  "subagent_create",
  "subagent_list",
  "subagent_profiles",
  "subagent_settle",
  "subagent_stop",
  "subagent_wait",
  "task_get",
  "task_set",
];
const parentOnly = new Set(WORKBENCH_PARENT_ONLY_TOOLS);

export function isWorkbenchToolVisibleTo(tool: string, subagent: boolean) {
  return !subagent || !parentOnly.has(tool);
}

// These agents call Workbench tools only through the wb MCP server, where calls are ordered and failures skip the rest.
const MCP_ONLY_HARNESSES: ReadonlySet<string> = new Set<WorkbenchProviderKey>(["claude"]);

/** Whether a managed agent of `harness` may run a command through the wb CLI rather than its MCP tool. */
export function isWorkbenchAgentCliOpenTo(harness: string, { onMcp }: { onMcp: boolean }) {
  return !onMcp || !MCP_ONLY_HARNESSES.has(harness);
}
