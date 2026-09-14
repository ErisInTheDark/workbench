/*
 * Exports:
 * - discoverReloadGraphSources: attach repository-local import ownership to a graph generation.
 */
import path from "node:path";
import type ReloadableNode from "./ReloadableNode";
import type { ReloadableNodeGraph } from "./ReloadableNode";

export function discoverReloadGraphSources<TContext, TObjects extends object, TNotification>(
  graph: ReloadableNodeGraph<TContext, TObjects, TNotification>,
  rootModule: NodeModule,
  options: { repoRoot: string; modules: readonly NodeModule[]; processModule?: NodeModule },
) {
  const workspacePath = (filename: string) => {
    const relative = path.relative(options.repoRoot, path.resolve(filename));
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
    const normalized = relative.replace(/\\/gu, "/");
    if (normalized.split("/").includes("node_modules") || /\.test\.[^/]+$/u.test(normalized)) return null;
    return normalized;
  };
  const nodes = new Map<string, ReloadableNode<TContext, TObjects, TNotification>>();
  const visitNode = (node: ReloadableNode<TContext, TObjects, TNotification>) => {
    if (nodes.has(node.scope)) return;
    nodes.set(node.scope, node);
    node.children.forEach(visitNode);
  };
  graph.roots.forEach(visitNode);
  const defining = new Map<string, NodeModule>();
  for (const loaded of options.modules) {
    const exported = loaded.exports as { default?: object } | object;
    const candidate = exported && typeof exported === "object" && "default" in exported ? exported.default : exported;
    for (const [scope, node] of nodes) if (candidate === node) defining.set(scope, loaded);
  }
  const walk = (root: NodeModule, stops: ReadonlySet<string>) => {
    const visited = new Set<NodeModule>();
    const paths = new Set<string>();
    const visit = (current: NodeModule, isRoot: boolean) => {
      if (visited.has(current) || (!isRoot && stops.has(current.filename))) return;
      visited.add(current);
      const source = workspacePath(current.filename);
      if (source) paths.add(source);
      if (path.resolve(current.filename).replace(/\\/gu, "/").split("/").includes("node_modules")) return;
      current.children.forEach(child => visit(child, false));
    };
    visit(root, true);
    return [...paths].sort();
  };
  const boundaries = new Set([...defining.values()].map(({ filename }) => filename));
  const pathsByScope = new Map<string, string[]>();
  const topologyPaths = new Set<string>();
  const rootPath = workspacePath(rootModule.filename);
  if (rootPath) topologyPaths.add(rootPath);
  for (const [scope, loaded] of defining) {
    pathsByScope.set(scope, walk(loaded, boundaries));
    const source = workspacePath(loaded.filename);
    if (source) topologyPaths.add(source);
  }
  for (const observation of graph.sourceObservations ?? []) {
    const source = workspacePath(observation.path);
    if (!source || !nodes.has(observation.scope)) continue;
    const paths = pathsByScope.get(observation.scope) ?? [];
    paths.push(source);
    pathsByScope.set(observation.scope, paths);
  }
  return Object.freeze({
    ...graph,
    sourceMetadata: {
      pathsByScope: new Map([...pathsByScope].map(([scope, paths]) => [scope, [...new Set(paths)].sort()])),
      topologyPaths: [...topologyPaths].sort(),
      processPaths: options.processModule ? walk(options.processModule, new Set([rootModule.filename])) : [],
    },
  });
}
