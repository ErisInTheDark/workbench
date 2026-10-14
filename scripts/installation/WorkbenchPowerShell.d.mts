/*
 * Exports:
 * - WorkbenchPowerShellOptions: injectable runtime manager inputs.
 * - WorkbenchPowerShell (default): typed managed PowerShell provisioning contract.
 */
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
