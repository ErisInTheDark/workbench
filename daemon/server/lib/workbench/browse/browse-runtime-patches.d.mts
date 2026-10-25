/*
 * Exports: types for ./browse-runtime-patches.mjs, which patches untyped upstream Browse modules at runtime.
 * - installHiddenChildProcessDefaults/patchBrowseRuntime/patchStagehandOptions.
 */
export function installHiddenChildProcessDefaults(argv?: readonly string[]): void;
export function patchBrowseRuntime(): Promise<void>;
export function patchStagehandOptions(
  sessionManagerModule: object,
  options?: { downloadsPath?: string; userDataDir?: string },
): void;
