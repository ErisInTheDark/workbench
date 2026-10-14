/*
 * Exports:
 * - WORKBENCH_POWERSHELL_VERSION: pinned managed PowerShell release.
 * - managedPowerShellExecutable: derive the deterministic managed pwsh.exe path.
 * - WorkbenchPowerShellOptions: injectable runtime manager inputs.
 * - WorkbenchPowerShell (default): typed managed PowerShell provisioning contract.
 */
export const WORKBENCH_POWERSHELL_VERSION: string;
export function managedPowerShellExecutable(dataRoot: string, arch?: string): string;

export interface WorkbenchPowerShellOptions {
  environment?: NodeJS.ProcessEnv;
  dataRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export default class WorkbenchPowerShell {
  constructor(options?: WorkbenchPowerShellOptions);
  executable(): string;
  resolve(): Promise<string | null>;
  ensure(options?: { onOutput?: (text: string) => void }): Promise<string | null>;
}
