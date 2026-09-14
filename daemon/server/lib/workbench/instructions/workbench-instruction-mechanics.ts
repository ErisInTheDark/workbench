/*
 * Exports:
 * - isManagedPromptThread: recognise installed managed capabilities before or after native creation.
 * - listWorkbenchInstructionMechanics: resolve managed mechanics and local capability availability.
 */

import WorkbenchServerSettings from "../settings/WorkbenchServerSettings";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return context.managedThread === true || Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

export async function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext) {
  const available = new Set<string>();
  if (context.managedThread || context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("long-waits");
    available.add("subagents");
    try {
      const settings = new WorkbenchServerSettings();
      const localCapabilities = await settings.readLocalCapabilities();
      if (localCapabilities.browseRawCommandsEnabled) available.add("browse-raw");
    } catch {
      console.error("[workbench-instructions] failed to read local capabilities; raw Browse commands remain unavailable.");
    }
  }
  if ((context.roots?.length ?? 0) > 1) available.add("multi-root");
  if (isManagedPromptThread(context)) {
    available.add("thread-git");
    available.add("thread-recall");
    available.add("thread-refresh");
    available.add("task-status");
    if (!context.subagentName?.trim()) available.add("task-title");
  }
  return available;
}
