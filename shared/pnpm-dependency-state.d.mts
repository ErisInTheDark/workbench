/*
 * Exports:
 * - APP_DEPENDENCY_IMPORTERS/DAEMON_DEPENDENCY_IMPORTERS: workspace importers each process shell loads.
 * - lockfileClosure: snapshot keys reachable from importers in pnpm lockfile text.
 * - readDependencyFingerprint: hash the wanted or installed closure of importers.
 * - hasDependencyDrift: whether installed dependencies differ from the lockfile.
 */
export const APP_DEPENDENCY_IMPORTERS: readonly string[];
export const DAEMON_DEPENDENCY_IMPORTERS: readonly string[];
/** Omitted importers mean every importer in the lockfile. */
export function lockfileClosure(text: string, importers?: readonly string[]): string[];
export function readDependencyFingerprint(
  root: string,
  which: "wanted" | "installed",
  importers?: readonly string[],
): Promise<string | null>;
export function hasDependencyDrift(root: string, importers?: readonly string[]): Promise<boolean>;
