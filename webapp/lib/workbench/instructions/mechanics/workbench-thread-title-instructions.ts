/*
 * Exports:
 * - buildThreadTitleInstructions: render managed top-level thread title guidance. Keywords: thread, title, cli.
 */

import { buildThreadTitleBootstrapInstructions } from "../../../thread-bootstrap";
import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";
import { isManagedPromptThread } from "./workbench-instruction-mechanics";

export function buildThreadTitleInstructions(context: WorkbenchPromptContext) {
  if (!isManagedPromptThread(context) || context.subagentName?.trim()) {
    return null;
  }

  return buildThreadTitleBootstrapInstructions();
}
