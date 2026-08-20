/*
 * Exports:
 * - Workbench mechanic builders/listWorkbenchInstructionMechanics: render fresh Markdown for available CLI mechanics. Keywords: instructions, mechanics, CLI.
 */

import WorkbenchServerSettings from "../../settings/WorkbenchServerSettings";
import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";
import { readInstructionSource } from "../instruction-source";

export function isMaterializedPromptThread(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  return Boolean(threadId && threadId !== "new" && !threadId.startsWith("draft:") && context.workbenchOrigin?.trim());
}

export function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext) {
  const available = new Set<string>();
  if (context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("orchestrator-reload");
    available.add("subagents");
  }
  if (isMaterializedPromptThread(context)) {
    available.add("thread-git");
    available.add("thread-recall");
    available.add("thread-status");
    if (!context.subagentName?.trim()) available.add("thread-title");
  }
  return available;
}

export async function buildWorkbenchBrowseInstructions(context: WorkbenchPromptContext) {
  if (!context.workbenchOrigin?.trim()) return null;
  const instructions = readInstructionSource("mechanics/workbench-browse-instructions.md");
  let rawCommandStatus = "Raw Browse CLI-args passthrough is currently disabled.";
  try {
    const settings = new WorkbenchServerSettings();
    const localCapabilities = await settings.readLocalCapabilities();
    rawCommandStatus = localCapabilities.browseRawCommandsEnabled
      ? "Raw Browse CLI-args passthrough is currently enabled."
      : "Raw Browse CLI-args passthrough is currently disabled.";
  } catch {
    rawCommandStatus = "Raw Browse CLI-args passthrough status could not be read; assume it is disabled unless the user confirms otherwise.";
  }
  return instructions.replaceAll("{{browse.rawCommandStatus}}", rawCommandStatus);
}

export function buildWorkbenchGitInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) return null;
  return readInstructionSource("mechanics/workbench-git-instructions.md").replaceAll("{{thread.id}}", threadId);
}

export function buildWorkbenchOrchestratorReloadInstructions(context: WorkbenchPromptContext) {
  return context.workbenchOrigin?.trim()
    ? readInstructionSource("mechanics/workbench-orchestrator-reload-instructions.md")
    : null;
}

export function buildWorkbenchSubagentInstructions(context: WorkbenchPromptContext) {
  return context.workbenchOrigin?.trim()
    ? readInstructionSource("mechanics/workbench-subagent-instructions.md")
    : null;
}

export function buildWorkbenchThreadRecallInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) return null;
  return readInstructionSource("mechanics/workbench-thread-recall-instructions.md").replaceAll("{{thread.id}}", threadId);
}

export function buildThreadStatusInstructions(context: WorkbenchPromptContext) {
  return isMaterializedPromptThread(context)
    ? readInstructionSource("mechanics/workbench-thread-status-instructions.md")
    : null;
}
