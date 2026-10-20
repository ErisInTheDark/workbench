/*
 * Exports:
 * - ReloadModuleSharing: which modules may stay cached across reloads while unchanged, and how each reload reports what it kept.
 * - createReloadableNodeModuleLoader: load graph definitions with optional repository source discovery; reloads release retired module generations.
 */
import type { ReloadableNodeGraph } from "./ReloadableNode.ts";
import type { ReloadableNodeModuleLoader } from "./ReloadableNodeHost.ts";
import { discoverReloadGraphSources, type ReloadEntryImportResolver } from "./reload-source-discovery.ts";
import {
  collectRequireCacheSubtree, collectUnchangedModules, readSourceSignatureSync, releaseRetiredModules,
} from "./require-cache-generations.ts";

export interface ReloadModuleSharing {
  /** Shareable modules stay cached while their source and every repository module they import are unchanged. */
  shareable(filename: string): boolean;
  report?(summary: { kept: number; reloaded: number }): void;
}

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>(
  loader: NodeRequire,
  rootSpecifier: string,
  sourceOptions?: { repoRoot: string; processModule?: NodeModule; resolveEntryImports?: ReloadEntryImportResolver },
  sharing?: ReloadModuleSharing,
): ReloadableNodeModuleLoader<TContext, TObjects, TNotification> {
  /** Source signatures of the cached shareable modules as they were evaluated; a missing entry must re-evaluate. */
  const evaluated = new Map<string, string>();
  const loadGraph = () => {
    const graph = (loader(rootSpecifier) as { default: ReloadableNodeGraph<TContext, TObjects, TNotification> }).default;
    if (!sourceOptions) return graph;
    const rootModule = loader.cache[loader.resolve(rootSpecifier)];
    if (!rootModule) throw new Error("Loaded graph module is unavailable for source discovery.");
    return discoverReloadGraphSources(graph, rootModule, {
      ...sourceOptions,
      modules: Object.values(loader.cache).filter((loaded): loaded is NodeModule => !!loaded),
    });
  };
  const load = (kept: ReadonlySet<string>) => {
    const startedAtMs = Date.now();
    const graph = loadGraph();
    if (!sharing) return graph;
    for (const moduleId of collectRequireCacheSubtree(loader, loader.resolve(rootSpecifier))) {
      if (kept.has(moduleId) || !sharing.shareable(moduleId)) continue;
      const source = readSourceSignatureSync(moduleId);
      // An edit racing this load may not be in the compiled copy, so the next reload must evaluate it again.
      if (source.modifiedAtMs < startedAtMs) evaluated.set(moduleId, source.signature);
    }
    return graph;
  };
  return {
    load: () => load(new Set()),
    reload: () => {
      const subtree = collectRequireCacheSubtree(loader, loader.resolve(rootSpecifier));
      const kept = sharing
        ? collectUnchangedModules(loader, subtree, moduleId => (
          evaluated.has(moduleId) && evaluated.get(moduleId) === readSourceSignatureSync(moduleId).signature
        ))
        : new Set<string>();
      const retired = new Set<NodeModule>();
      for (const moduleId of subtree) {
        if (kept.has(moduleId)) continue;
        retired.add(loader.cache[moduleId]!);
        delete loader.cache[moduleId];
        evaluated.delete(moduleId);
      }
      const graph = load(kept);
      // A failed load leaves the retired generation running, so only a successful one may release it.
      releaseRetiredModules(loader, retired);
      sharing?.report?.({ kept: kept.size, reloaded: retired.size });
      return graph;
    },
  };
}
