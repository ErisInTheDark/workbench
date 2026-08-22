/*
 * Exports:
 * - buildThreadTitleInstructions: render managed top-level thread title guidance. Keywords: thread, title, MCP.
 */

import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";
import { readInstructionSource } from "../instruction-source";
import { isManagedPromptThread } from "./workbench-instruction-mechanics";

export function buildThreadTitleInstructions(context: WorkbenchPromptContext) {
  if (!isManagedPromptThread(context) || context.subagentName?.trim()) {
    return null;
  }

  return readInstructionSource("mechanics/workbench-thread-title-instructions.md");
}
