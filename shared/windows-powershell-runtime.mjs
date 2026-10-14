/*
 * Exports:
 * - WORKBENCH_POWERSHELL_VERSION: pinned managed PowerShell release.
 * - managedPowerShellExecutable: derive the deterministic managed pwsh.exe path.
 */
import path from "node:path";

export const WORKBENCH_POWERSHELL_VERSION = "7.6.6";

export function managedPowerShellExecutable(dataRoot, arch = process.arch) {
  return path.join(path.resolve(dataRoot), "toolchain", "powershell", WORKBENCH_POWERSHELL_VERSION, arch, "pwsh.exe");
}
