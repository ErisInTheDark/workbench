/*
 * Exports:
 * - buildThreadTitleInstructions: render materialized top-level thread title guidance. Keywords: thread, title, cli.
 */

import { buildThreadTitleBootstrapInstructions } from "../../../thread-bootstrap";
import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";

export function buildThreadTitleInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || context.subagentName?.trim() || !context.workbenchOrigin?.trim()) {
    return null;
  }

  return buildThreadTitleBootstrapInstructions({
    harness: context.harness ?? "codex",
    threadId,
  });
}

