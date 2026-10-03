/*
 * Exports:
 * - WORKBENCH_PARENT_ONLY_TOOLS: tools whose work belongs to the coordinating parent.
 * - isWorkbenchToolVisibleTo: select tools for parent or subagent presentation and admission.
 */
export const WORKBENCH_PARENT_ONLY_TOOLS: readonly string[] = ["git_arc_propose"];
const parentOnly = new Set(WORKBENCH_PARENT_ONLY_TOOLS);

export function isWorkbenchToolVisibleTo(tool: string, subagent: boolean) {
  return !subagent || !parentOnly.has(tool);
}
