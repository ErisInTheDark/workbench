/*
 * Exports:
 * - createReloadableNodeModuleLoader: load the daemon root through the shared cache-subtree loader.
 */
import { createReloadableNodeModuleLoader as createSharedLoader } from "workbench-shared/reload/reloadable-node-loader";
import path from "node:path";
import ProjectImportGraph from "./lib/workbench/ProjectImportGraph";

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>() {
  const repoRoot = path.resolve(__dirname, "../..");
  return createSharedLoader<TContext, TObjects, TNotification>(require, "./daemon-root-node", {
    repoRoot,
    processModule: require.main,
    // Out-of-process entries (workers, child scripts, plugins) never join this module graph; read them from disk per load.
    resolveEntryImports: entries => new ProjectImportGraph(repoRoot, entries).closure(entries),
  });
}
