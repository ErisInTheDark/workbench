/*
 * Exports:
 * - isManagedPromptThread: recognise installed managed capabilities before or after native creation.
 * - listWorkbenchInstructionMechanics: resolve one caller's `<workspace:…>` facts and `<setting:…>` local capability settings.
 */

import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchInstructionFacts, WorkbenchInstructionSetting, WorkbenchInstructionWorkspaceFact } from "./instruction-context-filter";
import type { WorkbenchPromptContext } from "./workbench-prompt-types";
import { isDaemonWorkspacePath } from "../../daemon-workspace-paths";

export function isManagedPromptThread(context: WorkbenchPromptContext) {
  return context.managedThread === true || Boolean(context.threadId?.trim() && context.workbenchOrigin?.trim());
}

/** Tool-backed mechanics need no fact here: `<docs tools>` regions follow the caller's visible tool catalogue. */
export async function listWorkbenchInstructionMechanics(
  context: WorkbenchPromptContext,
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings> = async () => ({ browseRawCommandsEnabled: false }),
): Promise<WorkbenchInstructionFacts> {
  const workspace = new Set<WorkbenchInstructionWorkspaceFact>();
  const settings = new Set<WorkbenchInstructionSetting>();
  if ((context.roots?.length ?? 0) > 1) workspace.add("multi-root");
  // Daemon-project threads run on the machine itself: no repository, so no Git mechanics.
  const daemonWorkspace = Boolean(context.roots?.length) && context.roots!.every(root => isDaemonWorkspacePath(root.rootPath));
  workspace.add(daemonWorkspace ? "daemon" : "project");
  try {
    if ((await readLocalCapabilities()).browseRawCommandsEnabled) settings.add("browse-raw");
  } catch {
    console.error("[workbench-instructions] failed to read local capabilities; raw Browse commands remain unavailable.");
  }
  return { settings, workspace };
}
