/*
 * Exports:
 * - isManagedPromptThread: detect prompt contexts that belong to a managed Workbench thread. Keywords: instructions, thread, context.
 * - listWorkbenchInstructionMechanics: list typed Workbench mechanics relevant to a prompt context. Keywords: instructions, mechanics, availability.
 * - readWorkbenchBrowseRawCommandStatus: read the bounded dynamic Browse capability status for emitted mechanics. Keywords: browse, capability, runtime.
 */

import WorkbenchServerSettings from "../settings/WorkbenchServerSettings";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

export function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext) {
  const available = new Set<string>();
  if (context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("long-waits");
    available.add("subagents");
  }
  if ((context.roots?.length ?? 0) > 1) available.add("multi-root");
  if (isManagedPromptThread(context)) {
    available.add("thread-git");
    available.add("thread-recall");
    available.add("thread-refresh");
    available.add("thread-status");
    if (!context.subagentName?.trim()) available.add("thread-title");
  }
  return available;
}

export async function readWorkbenchBrowseRawCommandStatus() {
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
  return rawCommandStatus;
}
