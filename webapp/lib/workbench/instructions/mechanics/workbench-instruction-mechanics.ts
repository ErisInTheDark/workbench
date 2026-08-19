/*
 * Exports:
 * - Workbench mechanic builders/listWorkbenchInstructionMechanics: render module-cached Markdown for available CLI mechanics. Keywords: instructions, mechanics, CLI.
 */

import WorkbenchServerSettings from "../../settings/WorkbenchServerSettings";
import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";
import { readInstructionSource } from "../instruction-source";

const WORKBENCH_BROWSE_INSTRUCTIONS = readInstructionSource("mechanics/workbench-browse-instructions.md");
const WORKBENCH_GIT_INSTRUCTIONS = readInstructionSource("mechanics/workbench-git-instructions.md");
const WORKBENCH_ORCHESTRATOR_RELOAD_INSTRUCTIONS = readInstructionSource("mechanics/workbench-orchestrator-reload-instructions.md");
const WORKBENCH_SUBAGENT_INSTRUCTIONS = readInstructionSource("mechanics/workbench-subagent-instructions.md");
const WORKBENCH_THREAD_RECALL_INSTRUCTIONS = readInstructionSource("mechanics/workbench-thread-recall-instructions.md");
const WORKBENCH_THREAD_STATUS_INSTRUCTIONS = readInstructionSource("mechanics/workbench-thread-status-instructions.md");

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
  return WORKBENCH_BROWSE_INSTRUCTIONS.replaceAll("{{browse.rawCommandStatus}}", rawCommandStatus);
}

export function buildWorkbenchGitInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) return null;
  return WORKBENCH_GIT_INSTRUCTIONS.replaceAll("{{thread.id}}", threadId);
}

export function buildWorkbenchOrchestratorReloadInstructions(context: WorkbenchPromptContext) {
  return context.workbenchOrigin?.trim() ? WORKBENCH_ORCHESTRATOR_RELOAD_INSTRUCTIONS : null;
}

export function buildWorkbenchSubagentInstructions(context: WorkbenchPromptContext) {
  return context.workbenchOrigin?.trim() ? WORKBENCH_SUBAGENT_INSTRUCTIONS : null;
}

export function buildWorkbenchThreadRecallInstructions(context: WorkbenchPromptContext) {
  const threadId = context.threadId?.trim();
  if (!threadId || threadId === "new" || threadId.startsWith("draft:") || !context.workbenchOrigin?.trim()) return null;
  return WORKBENCH_THREAD_RECALL_INSTRUCTIONS.replaceAll("{{thread.id}}", threadId);
}

export function buildThreadStatusInstructions(context: WorkbenchPromptContext) {
  return isMaterializedPromptThread(context) ? WORKBENCH_THREAD_STATUS_INSTRUCTIONS : null;
}
