/*
 * Exports:
 * - WORKBENCH_PARENT_ONLY_TOOLS: tools whose work belongs to the coordinating parent.
 * - isWorkbenchCommandVisibleTo: select commands for one provider and parent/subagent audience.
 * - isWorkbenchToolVisibleTo: select tools for parent or subagent presentation and admission.
 */
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

export function isWorkbenchCommandVisibleTo(
  tool: string,
  { harness, harnesses, subagent }: {
    harness: string;
    harnesses?: readonly string[];
    subagent: boolean;
  },
) {
  return isWorkbenchToolVisibleTo(tool, subagent) && (!harnesses || harnesses.includes(harness));
}
