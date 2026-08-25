/*
 * Exports:
 * - createReloadableNodeModuleLoader: load the parent-owned root graph and invalidate its project-local cache subtree. Keywords: reload, topology, cache.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost";

const ROOT_SPECIFIER = "./orchestrator-root-node";

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) return visited;
  const cachedModule = require.cache[moduleId];
  if (!cachedModule) return visited;
  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (child?.id && !/[\\/]node_modules[\\/]/u.test(child.id)) collectCacheSubtree(child.id, visited);
  }
  return visited;
}

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>(): ReloadableNodeModuleLoader<TContext, TObjects, TNotification> {
  const load = () => (require(ROOT_SPECIFIER) as { default: ReloadableNodeGraph<TContext, TObjects, TNotification> }).default;
  return {
    load,
    reload: () => {
      const rootId = require.resolve(ROOT_SPECIFIER);
      for (const moduleId of collectCacheSubtree(rootId)) delete require.cache[moduleId];
      return load();
    },
  };
}
