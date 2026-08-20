/*
 * Exports:
 * - isManagedPromptThread: detect prompt contexts that belong to a managed Workbench thread. Keywords: instructions, thread, context.
 * - listWorkbenchInstructionMechanics: list CLI mechanics relevant to a prompt context. Keywords: instructions, mechanics, availability.
 * - buildWorkbenchBrowseInstructions: render fresh Browse CLI mechanics. Keywords: browse, instructions, CLI.
 * - buildWorkbenchGitInstructions: render fresh managed Git CLI mechanics. Keywords: git, instructions, CLI.
 * - buildWorkbenchOrchestratorReloadInstructions: render fresh orchestrator reload mechanics. Keywords: orchestrator, reload, instructions.
 * - buildWorkbenchSubagentInstructions: render fresh subagent CLI mechanics. Keywords: subagent, instructions, CLI.
 * - buildWorkbenchThreadRecallInstructions: render fresh current-thread recall mechanics. Keywords: thread, recall, instructions.
 * - buildThreadStatusInstructions: render fresh current-thread status mechanics. Keywords: thread, status, instructions.
 */

import WorkbenchServerSettings from "../../settings/WorkbenchServerSettings";
import type { WorkbenchPromptContext } from "../assembly/workbench-prompt-types";
import { readInstructionSource } from "../instruction-source";

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

export function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext) {
  const available = new Set<string>();
  if (context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("orchestrator-reload");
    available.add("subagents");
  }
  if (isManagedPromptThread(context)) {
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
  return isManagedPromptThread(context)
    ? readInstructionSource("mechanics/workbench-git-instructions.md")
    : null;
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
  return isManagedPromptThread(context)
    ? readInstructionSource("mechanics/workbench-thread-recall-instructions.md")
    : null;
}

export function buildThreadStatusInstructions(context: WorkbenchPromptContext) {
  return isManagedPromptThread(context)
    ? readInstructionSource("mechanics/workbench-thread-status-instructions.md")
    : null;
}
