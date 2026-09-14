/*
 * Exports:
 * - createReloadableNodeModuleLoader: load graph definitions with optional repository source discovery.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode.ts";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost.ts";
import { discoverReloadGraphSources } from "./reload-source-discovery.ts";

function collectCacheSubtree(loader: NodeRequire, moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) return visited;
  const cachedModule = loader.cache[moduleId];
  if (!cachedModule) return visited;
  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (child?.id && !/[\\/]node_modules[\\/]/u.test(child.id)) collectCacheSubtree(loader, child.id, visited);
  }
  return visited;
}

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>(
  loader: NodeRequire,
  rootSpecifier: string,
  sourceOptions?: { repoRoot: string; processModule?: NodeModule },
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
      for (const moduleId of collectCacheSubtree(loader, rootId)) delete loader.cache[moduleId];
      return load();
    },
  };
}
