/*
 * Exports:
 * - collectRequireCacheSubtree: list the cached repository modules beneath one module, excluding node_modules.
 * - releaseRetiredModules: cut every surviving path to retired module generations so they can be collected.
 * - createSourceTrackedModule: load one module subtree, reusing it until a source file changes, then swap in a fresh generation without leaking the old one.
 */
import fs from "node:fs/promises";

export function collectRequireCacheSubtree(loader: NodeRequire, moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) return visited;
  const cachedModule = loader.cache[moduleId];
  if (!cachedModule) return visited;
  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (child?.id && !/[\\/]node_modules[\\/]/u.test(child.id)) collectRequireCacheSubtree(loader, child.id, visited);
  }
  return visited;
}

/**
 * Node appends every newly loaded module to its parent's `children` and never removes it. Without repair, the
 * non-reloadable parent of a reloaded root keeps every retired generation, and its whole module tree, alive.
 */
export function releaseRetiredModules(loader: NodeRequire, retired: ReadonlySet<NodeModule>) {
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

const UNSETTLED = "unsettled";

async function readSourceSignature(path: string) {
  try {
    const stat = await fs.stat(path);
    return { modifiedAtMs: stat.mtimeMs, signature: `${stat.mtimeMs}:${stat.size}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { modifiedAtMs: 0, signature: "missing" };
    throw error;
  }
}

interface SourceTrackedGeneration<T> {
  readonly signatures: ReadonlyMap<string, string>;
  readonly value: T;
}

/** `moduleId` must be resolved; `loader` is the parent module's require so its `children` stay repaired. */
export function createSourceTrackedModule<T>(loader: NodeRequire, moduleId: string) {
  let current: SourceTrackedGeneration<T> | null = null;
  let pending: Promise<T> | null = null;
  // Retired by a load that then failed; still reachable until a successful load can release them.
  const unreleased = new Set<NodeModule>();

  const isCurrent = async (generation: SourceTrackedGeneration<T>) => {
    const checks = await Promise.all([...generation.signatures].map(async ([path, signature]) => (
      signature !== UNSETTLED && (await readSourceSignature(path)).signature === signature
    )));
    return checks.every(Boolean);
  };

  const loadFresh = async (): Promise<SourceTrackedGeneration<T>> => {
    const startedAtMs = Date.now();
    for (const id of collectRequireCacheSubtree(loader, moduleId)) {
      unreleased.add(loader.cache[id]!);
      delete loader.cache[id];
    }
    const value = loader(moduleId) as T;
    releaseRetiredModules(loader, unreleased);
    unreleased.clear();
    const sources = [...collectRequireCacheSubtree(loader, moduleId)];
    const signatures = new Map(await Promise.all(sources.map(async (path) => {
      const source = await readSourceSignature(path);
      // An edit racing this load may not be in the compiled copy, so the next load must look again.
      return [path, source.modifiedAtMs >= startedAtMs ? UNSETTLED : source.signature] as const;
    })));
    return { signatures, value };
  };

  const refresh = async () => {
    if (current && await isCurrent(current)) return current.value;
    current = await loadFresh();
    return current.value;
  };

  return {
    /** Concurrent callers share one freshness check; a failed load rejects and leaves the previous generation current. */
    load(): Promise<T> {
      pending ??= refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}
