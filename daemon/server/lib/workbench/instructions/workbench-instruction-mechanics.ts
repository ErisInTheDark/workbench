/*
 * Exports:
 * - isManagedPromptThread: recognise installed managed capabilities before or after native creation.
 * - listWorkbenchInstructionMechanics: resolve managed mechanics and local capability availability.
 */

import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchInstructionTool } from "./instruction-tool-reference";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";
import { isDaemonWorkspacePath } from "../../daemon-workspace-paths";

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return context.managedThread === true || Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

export async function listWorkbenchInstructionMechanics(
  context: WorkbenchPromptContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings> = async () => ({ browseRawCommandsEnabled: false }),
  catalogue: readonly WorkbenchInstructionTool[] = [],
) {
  const available = new Set<string>();
  if (catalogue.some(tool => tool.id === "git_repo")) available.add("remote-repos");
  if (context.managedThread || context.workbenchOrigin?.trim()) {
    available.add("browse");
    available.add("long-waits");
    available.add("messages");
    available.add("subagents");
    try {
      const localCapabilities = await readLocalCapabilities();
      if (localCapabilities.browseRawCommandsEnabled) available.add("browse-raw");
    } catch {
      console.error("[workbench-instructions] failed to read local capabilities; raw Browse commands remain unavailable.");
    }
  }
  if ((context.roots?.length ?? 0) > 1) available.add("multi-root");
  // Daemon-project threads run on the machine itself: no repository, so no Git mechanics.
  const daemonWorkspace = Boolean(context.roots?.length) && context.roots!.every(root => isDaemonWorkspacePath(root.rootPath));
  if (daemonWorkspace) available.add("daemon-workspace");
  if (isManagedPromptThread(context)) {
    if (!daemonWorkspace) available.add("thread-git");
    available.add("thread-recall");
    available.add("thread-refresh");
    available.add("task-status");
    if (!context.subagentName?.trim()) {
      available.add("task-title");
      if (!daemonWorkspace) available.add("git-proposals");
    }
  }
  return available;
}
