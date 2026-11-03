/*
 * Exports:
 * - PRE_MODE_DENIAL: why a tool is refused before the thread's first mode.
 * - describeModeToolDenial/describeModeEditDenial: why the current mode refuses a tool or file edits.
 * - describeCompactionEditDenial: why an unrecovered compaction refuses edits.
 * - isWorkflowDenialText: whether tool output carries any of these refusals, including inside a wrapper's own failure text.
 */
import { describeCompactionRecovery, PRE_MODE_TOOLS, THREAD_STATE_TOOL, type CompactionRecovery } from "./workflow-modes.ts";

export const PRE_MODE_DENIAL = `No mode entered yet; only ${[...PRE_MODE_TOOLS].join(", ")} run. Enter a mode with ${THREAD_STATE_TOOL} first.`;

export function describeModeToolDenial(mode: string, toolName: string) {
  return `${mode} mode denies ${toolName}. Switch modes with ${THREAD_STATE_TOOL} first.`;
}

export function describeModeEditDenial(mode: string, what: "file edits" | "edits to Git-visible files", paths: readonly string[]) {
  return `${mode} mode denies ${what}: ${paths.join(", ")}. Switch modes with ${THREAD_STATE_TOOL}, or list committed process notes in alwaysEditable.`;
}

export function describeCompactionEditDenial(recovery: CompactionRecovery) {
  return `Context was compacted; edits need ${describeCompactionRecovery(recovery)} first.`;
}

const DENIAL_PATTERNS = [
  /(?:^|[\s:])[^\s:]+ mode denies \S/u,
  /No mode entered yet; only \S/u,
  /Context was compacted; edits need \S/u,
];

export function isWorkflowDenialText(text: string) {
  return DENIAL_PATTERNS.some(pattern => pattern.test(text));
}
