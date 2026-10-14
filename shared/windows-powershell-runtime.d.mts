/*
 * Exports:
 * - WORKBENCH_POWERSHELL_VERSION: pinned managed PowerShell release.
 * - managedPowerShellExecutable: derive the deterministic managed pwsh.exe path.
 */
export const WORKBENCH_POWERSHELL_VERSION: string;
export function managedPowerShellExecutable(dataRoot: string, arch?: string): string;
