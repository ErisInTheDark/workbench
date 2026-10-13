/*
 * Exports:
 * - WorkbenchDataRootOptions: environment, home and platform inputs for data storage.
 * - default resolveWorkbenchDataRoot: dependency-free per-user data location.
 */
export interface WorkbenchDataRootOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}
export default function resolveWorkbenchDataRoot(options?: WorkbenchDataRootOptions): string;
