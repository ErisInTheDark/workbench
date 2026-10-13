/*
 * Exports:
 * - WorkbenchDataRootOptions: environment, home, and platform seams for user-data path resolution.
 * - default resolveWorkbenchDataRoot: resolve Workbench's per-user OS data directory.
 */
export { default } from "../package/workbench-data-root.mjs";
export type { WorkbenchDataRootOptions } from "../package/workbench-data-root.mjs";
