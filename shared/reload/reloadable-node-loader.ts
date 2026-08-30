/*
 * Exports:
 * - createReloadableNodeModuleLoader: load the parent-owned root graph and invalidate its project-local cache subtree. Keywords: reload, topology, cache.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode.ts";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost.ts";

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
): ReloadableNodeModuleLoader<TContext, TObjects, TNotification> {
  const load = () => (loader(rootSpecifier) as { default: ReloadableNodeGraph<TContext, TObjects, TNotification> }).default;
  return {
    load,
    reload: () => {
      const rootId = loader.resolve(rootSpecifier);
      for (const moduleId of collectCacheSubtree(loader, rootId)) delete loader.cache[moduleId];
      return load();
    },
  };
}
