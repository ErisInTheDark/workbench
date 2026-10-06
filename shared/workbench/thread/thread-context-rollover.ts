/*
 * Exports:
 * - WORKBENCH_THREAD_COMPACT_TOOL_NAME/WORKBENCH_THREAD_COMPACT_NATIVE_TOOL_NAME: public and OpenCode-native tool identities.
 * - WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION_KEY/WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION: stable hidden active-turn directive.
 * - shouldRequestContextRollover: compare one native model step with the guarded selected cap.
 * - createWorkbenchContextRolloverInput/isWorkbenchContextRolloverInput: construct and recognise the hidden fresh-context opening.
 */
import type { UserInput } from "./workbench-thread-items.ts";
import { contextCompactionThreshold } from "./thread-profile.ts";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const WORKBENCH_THREAD_COMPACT_TOOL_NAME = "thread_compact";
export const WORKBENCH_THREAD_COMPACT_NATIVE_TOOL_NAME = `wb_${WORKBENCH_THREAD_COMPACT_TOOL_NAME}`;
export const WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION_KEY = "workbench-context-rollover";
export const WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION = [
  "Call `thread_compact` as your next action.",
  "Include a summary of everything you were doing, every relevant user message verbatim,",
  "the entire approved plan and every approved addendum when a plan exists, all remaining work,",
  "and intended next steps. Do not continue ordinary work before calling it.",
].join(" ");

const WORKBENCH_CONTEXT_ROLLOVER_WRAPPER = defineTagWrapper("wb:context-compaction", { attributes: [] });

export function shouldRequestContextRollover(contextTokens: number, selectedCap: number | null | undefined) {
  return selectedCap != null
    && Number.isInteger(contextTokens)
    && contextTokens >= contextCompactionThreshold(selectedCap);
}

export function createWorkbenchContextRolloverInput(summary: string): UserInput[] {
  const body = [
    "This is a post-context-compaction summary from the retired context.",
    "Continue the same task from this summary without commentary about the rollover.",
    "",
    summary.trim(),
  ].join("\n");
  return [{ type: "text", text: WORKBENCH_CONTEXT_ROLLOVER_WRAPPER.wrap(body, {}), text_elements: [] }];
}

export function isWorkbenchContextRolloverInput(input: readonly UserInput[]) {
  return input.length === 1
    && input[0]?.type === "text"
    && WORKBENCH_CONTEXT_ROLLOVER_WRAPPER.read(input[0].text) !== null;
}
