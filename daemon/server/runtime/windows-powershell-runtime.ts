/*
 * Exports:
 * - workbenchPowerShellExecutable: derive the pinned managed pwsh.exe path.
 * - requireWorkbenchPowerShellExecutable: fail with the user-owned repair action when that runtime is missing.
 */
import { access } from "node:fs/promises";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { managedPowerShellExecutable } from "../../../shared/windows-powershell-runtime.mjs";

export function workbenchPowerShellExecutable(dataRoot = resolveWorkbenchDataRoot()) {
  return managedPowerShellExecutable(dataRoot);
}

export async function requireWorkbenchPowerShellExecutable(dataRoot?: string) {
  const executable = workbenchPowerShellExecutable(dataRoot);
  try {
    await access(executable);
    return executable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`Workbench PowerShell is unavailable at ${executable}. Run wb repair from an interactive terminal, then relaunch Workbench.`, { cause: error });
  }
}
