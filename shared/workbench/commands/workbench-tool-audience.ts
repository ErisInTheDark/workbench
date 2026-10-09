/*
 * Exports:
 * - WORKBENCH_PARENT_ONLY_TOOLS: tools whose work belongs to the coordinating parent.
 * - isWorkbenchToolVisibleTo: select tools for parent or subagent presentation and admission.
 */
// Parents propose their children's work and title their tasks at creation.
export const WORKBENCH_PARENT_ONLY_TOOLS: readonly string[] = ["git_arc_propose", "task_get", "task_set"];
const parentOnly = new Set(WORKBENCH_PARENT_ONLY_TOOLS);

export function isWorkbenchToolVisibleTo(tool: string, subagent: boolean) {
  return !subagent || !parentOnly.has(tool);
}
