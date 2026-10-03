/*
 * Exports:
 * - createReloadableNodeModuleLoader: load graph definitions with optional repository source discovery; reloads release retired module generations.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode.ts";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost.ts";
import { discoverReloadGraphSources, type ReloadEntryImportResolver } from "./reload-source-discovery.ts";

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
      for (const moduleId of collectCacheSubtree(loader, rootId)) {
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

/**
 * Node appends every newly loaded module to its parent's `children` and never removes it. Without repair, the
 * non-reloadable parent of the graph root keeps every retired generation, and its whole module tree, alive.
 */
function releaseRetiredModules(loader: NodeRequire, retired: ReadonlySet<NodeModule>) {
  for (const surviving of Object.values(loader.cache)) {
    if (!surviving || !surviving.children.some(child => retired.has(child))) continue;
    // Point at the current copy so reload ownership discovery keeps seeing the same files.
    const current = surviving.children.map(child => retired.has(child) ? loader.cache[child.id] : child)
      .filter((child): child is NodeModule => !!child);
    surviving.children.splice(0, surviving.children.length, ...new Set(current));
  }
  // A stray reference to one retired module must not pin the tree beneath it.
  for (const module of retired) module.children.length = 0;
}
