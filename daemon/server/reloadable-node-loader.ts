/*
 * Exports:
 * - createReloadableNodeModuleLoader: load the daemon root through the shared cache-subtree loader, keeping unchanged `shared/` modules across reloads.
 */
import { createReloadableNodeModuleLoader as createSharedLoader } from "workbench-shared/reload/reloadable-node-loader";
import path from "node:path";
import ProjectImportGraph from "./lib/workbench/ProjectImportGraph";
import { log } from "./process-helpers";

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>() {
  const repoRoot = path.resolve(__dirname, "../..");
  const sharedRoot = path.join(repoRoot, "shared");
  return createSharedLoader<TContext, TObjects, TNotification>(require, "./daemon-root-node", {
    repoRoot,
    processModule: require.main,
    // Out-of-process entries (workers, child scripts, plugins) never join this module graph; read them from disk per load.
    resolveEntryImports: entries => new ProjectImportGraph(repoRoot, entries).closure(entries),
  }, {
    // Shared contracts are most of each generation's weight, mostly schemas; daemon code still reloads whole.
    shareable: filename => {
      const relative = path.relative(sharedRoot, filename);
      return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    },
    report: ({ kept, reloaded }) => log("daemon", `reload kept ${kept} unchanged shared modules, re-evaluated ${reloaded}`),
  });
}
