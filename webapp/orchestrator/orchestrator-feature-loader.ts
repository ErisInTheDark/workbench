/*
 * Exports:
 * - createOrchestratorFeatureModuleLoader: load the single registry root and invalidate its project-local cache subtree for a fresh generation. Keywords: reload, require cache, registry root.
 */
import type { OrchestratorFeatureModule, OrchestratorFeatureModuleLoader } from "./OrchestratorFeatureHost";

const REGISTRY_SPECIFIER = "./orchestrator-feature-registry";

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

export function createOrchestratorFeatureModuleLoader<TContext, TFeatures extends object, TNotification>(): OrchestratorFeatureModuleLoader<TContext, TFeatures, TNotification> {
  const load = () => require(REGISTRY_SPECIFIER) as OrchestratorFeatureModule<TContext, TFeatures, TNotification>;
  return {
    load,
    reload: () => {
      const registryId = require.resolve(REGISTRY_SPECIFIER);
      for (const moduleId of collectCacheSubtree(registryId)) delete require.cache[moduleId];
      return load();
    },
  };
}
