/*
 * Exports:
 * - isManagedPromptThread: recognise installed managed capabilities before or after native creation.
 * - listWorkbenchInstructionMechanics: resolve one caller's `<workspace:…>` facts.
 * - readWorkbenchInstructionCapabilities: read local capabilities for tool gating, treating a failed read as all disabled.
 */

import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchInstructionFacts, WorkbenchInstructionWorkspaceFact } from "./instruction-context-filter";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";
import { isDaemonWorkspacePath } from "../../daemon-workspace-paths";

const DISABLED_CAPABILITIES: WorkbenchLocalCapabilitySettings = { browseRawCommandsEnabled: false };

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return context.managedThread === true || Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

/** Tool-backed mechanics need no fact here: `<docs tools>` regions follow the caller's usable tool catalogue. */
export function listWorkbenchInstructionMechanics(context: WorkbenchPromptContext): WorkbenchInstructionFacts {
  const workspace = new Set<WorkbenchInstructionWorkspaceFact>();
  if ((context.roots?.length ?? 0) > 1) workspace.add("multi-root");
  // Daemon-project threads run on the machine itself: no repository, so no Git mechanics.
  const daemonWorkspace = Boolean(context.roots?.length) && context.roots!.every(root => isDaemonWorkspacePath(root.rootPath));
  workspace.add(daemonWorkspace ? "daemon" : "project");
  return { workspace };
}

export async function readWorkbenchInstructionCapabilities(
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>,
): Promise<WorkbenchLocalCapabilitySettings> {
  try {
    return await readLocalCapabilities();
  } catch {
    console.error("[workbench-instructions] failed to read local capabilities; capability-gated tools remain unavailable.");
    return DISABLED_CAPABILITIES;
  }
}
