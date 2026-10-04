/*
 * Exports:
 * - createReloadableNodeModuleLoader: load graph definitions with optional repository source discovery; reloads release retired module generations.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode.ts";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost.ts";
import { discoverReloadGraphSources, type ReloadEntryImportResolver } from "./reload-source-discovery.ts";
import { collectRequireCacheSubtree, releaseRetiredModules } from "./require-cache-generations.ts";

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>(
  loader: NodeRequire,
  rootSpecifier: string,
  sourceOptions?: { repoRoot: string; processModule?: NodeModule; resolveEntryImports?: ReloadEntryImportResolver },
): ReloadableNodeModuleLoader<TContext, TObjects, TNotification> {
  const load = () => {
    const graph = (loader(rootSpecifier) as { default: ReloadableNodeGraph<TContext, TObjects, TNotification> }).default;
    if (!sourceOptions) return graph;
    const rootModule = loader.cache[loader.resolve(rootSpecifier)];
    if (!rootModule) throw new Error("Loaded graph module is unavailable for source discovery.");
    return discoverReloadGraphSources(graph, rootModule, {
      ...sourceOptions,
      modules: Object.values(loader.cache).filter((loaded): loaded is NodeModule => !!loaded),
    });
  };
  return {
    load,
    reload: () => {
      const rootId = loader.resolve(rootSpecifier);
      const retired = new Set<NodeModule>();
      for (const moduleId of collectRequireCacheSubtree(loader, rootId)) {
        retired.add(loader.cache[moduleId]!);
        delete loader.cache[moduleId];
      }
      const graph = load();
      // A failed load leaves the retired generation running, so only a successful one may release it.
      releaseRetiredModules(loader, retired);
      return graph;
    },
  };
}
