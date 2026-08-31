/*
 * Exports:
 * - ReloadNodeSourceDescriptor/ReloadNodeSourceState: generated live source ownership and dependant metadata. Keywords: reload, source, graph, dirt.
 * - observeReloadNodeGraphSources: combine candidate-loaded module paths with explicit hostile-boundary patterns. Keywords: CommonJS, imports, worker, dynamic, ownership.
 * - activateReloadNodeSourceState/cancelReloadNodeSourceState: publish successful candidates or discard failed ones across module generations. Keywords: reload, activation, rollback.
 * - readReloadNodeSourceState: read active metadata without exposing an uncommitted candidate. Keywords: reload, generation, catalog.
 */
import path from "node:path";

import type {
  ReloadDirtSourceDescriptor,
  ReloadDirtSourceState,
} from "workbench-shared/reload/ReloadDirtController";

import type { OrchestratorReloadScope } from "../lib/types";
import type { OrchestratorReloadScopeDescriptor } from "../lib/workbench/orchestrator-reload";
import ReloadableNode, { type ReloadableNodeGraph } from "./ReloadableNode";

export type ReloadNodeSourceDescriptor = ReloadDirtSourceDescriptor & OrchestratorReloadScopeDescriptor;
export type ReloadNodeSourceState = ReloadDirtSourceState;

type GraphNode = ReloadableNode<object, object, object>;

const DESTRUCTIVE_SCOPES = new Set(["server:process", "harness:codex", "harness:opencode"]);
const SOURCE_STATE_KEY = Symbol.for("workbench.reload-node-source-state");

interface ReloadNodeSourceRegistry {
  active: ReloadNodeSourceState | null;
  pending: ReloadNodeSourceState | null;
}

function sourceRegistry() {
  const owner = globalThis as typeof globalThis & { [SOURCE_STATE_KEY]?: ReloadNodeSourceRegistry };
  return owner[SOURCE_STATE_KEY] ??= { active: null, pending: null };
}

function flatten(roots: readonly GraphNode[]) {
  const nodes = new Map<OrchestratorReloadScope, GraphNode>();
  const parents = new Map<OrchestratorReloadScope, Set<OrchestratorReloadScope>>();
  const visit = (node: GraphNode, parent: OrchestratorReloadScope | null) => {
    nodes.set(node.scope, node);
    if (parent) (parents.get(node.scope) ?? parents.set(node.scope, new Set()).get(node.scope)!).add(parent);
    for (const child of node.children as readonly GraphNode[]) visit(child, node.scope);
  };
  for (const root of roots) visit(root, null);
  return { nodes, parents };
}

function findDefiningModules(nodes: ReadonlyMap<OrchestratorReloadScope, GraphNode>) {
  const result = new Map<OrchestratorReloadScope, NodeModule>();
  for (const loaded of Object.values(require.cache)) {
    if (!loaded) continue;
    const exported = loaded.exports as { default?: object } | object;
    const candidate = typeof exported === "object" && exported && "default" in exported ? exported.default : exported;
    for (const [scope, node] of nodes) if (candidate === node) result.set(scope, loaded);
  }
  return result;
}

function workspacePath(filename: string) {
  const normalized = path.resolve(filename).replace(/\\/gu, "/");
  if (normalized.includes("/node_modules/")) return null;
  const marker = normalized.lastIndexOf("/webapp/");
  return marker < 0 ? null : normalized.slice(marker + 1);
}

function walkModules(root: NodeModule, stop: ReadonlySet<NodeModule>, skipRoot = false) {
  const visited = new Set<NodeModule>();
  const stopFilenames = new Set([...stop].map(({ filename }) => filename));
  const paths = new Set<string>();
  const visit = (current: NodeModule, isRoot: boolean) => {
    if (visited.has(current) || (!isRoot && stopFilenames.has(current.filename))) return;
    visited.add(current);
    if (!skipRoot || !isRoot) {
      const sourcePath = workspacePath(current.filename);
      if (sourcePath) paths.add(sourcePath);
    }
    for (const child of current.children) visit(child, false);
  };
  visit(root, true);
  return { modules: visited, paths };
}

function cloneGraphNode(node: GraphNode, sources: readonly string[], children: readonly GraphNode[]) {
  const boundaryPatterns = readSourcePatterns(node.boundarySources);
  return new ReloadableNode<object, object, object>({
    access: node.access,
    boundarySources: node.boundarySources,
    children,
    create: node.create,
    description: node.description,
    lifecycle: node.lifecycle,
    provides: node.provides,
    requires: node.requires,
    safeAll: node.safeAll,
    scope: node.scope,
    sources: [...sources, ...boundaryPatterns].join("\n"),
  });
}

function readSourcePatterns(sources: string) {
  return sources
    .split(/\r?\n/u)
    .map((source) => source.trim())
    .filter(Boolean);
}

export function observeReloadNodeGraphSources<TContext, TObjects extends object, TNotification>(
  graph: ReloadableNodeGraph<TContext, TObjects, TNotification>,
  rootModule: NodeModule,
  instructionPaths: readonly string[],
): ReloadableNodeGraph<TContext, TObjects, TNotification> {
  const originalRoots = graph.roots as readonly unknown[] as readonly GraphNode[];
  const { nodes, parents } = flatten(originalRoots);
  const defining = findDefiningModules(nodes);
  const boundaries = new Set(defining.values());
  const topologyInfrastructure = new Set<string>([
    workspacePath(rootModule.filename),
    workspacePath(__filename),
    workspacePath(require.resolve("./ReloadableNode")),
  ].filter((value): value is string => !!value));
  const pathsByScope = new Map<OrchestratorReloadScope, Set<string>>();
  const add = (scope: OrchestratorReloadScope, sourcePath: string) => {
    (pathsByScope.get(scope) ?? pathsByScope.set(scope, new Set()).get(scope)!).add(sourcePath);
  };

  for (const [scope, nodeModule] of defining) {
    const walked = walkModules(nodeModule, boundaries);
    const nodePath = workspacePath(nodeModule.filename);
    if (nodePath) {
      add(scope, nodePath);
      add("server:topology", nodePath);
    }
    for (const sourcePath of walked.paths) {
      if (topologyInfrastructure.has(sourcePath)) add("server:topology", sourcePath);
      else add(scope, sourcePath);
    }
  }
  for (const sourcePath of topologyInfrastructure) add("server:topology", sourcePath);
  for (const absolutePath of instructionPaths) {
    const sourcePath = workspacePath(absolutePath);
    if (sourcePath) add("server:instructions", sourcePath);
  }

  const graphModules = walkModules(rootModule, new Set()).modules;
  if (require.main) {
    const processWalk = walkModules(require.main, new Set([rootModule]));
    for (const loaded of processWalk.modules) {
      if (graphModules.has(loaded)) continue;
      const sourcePath = workspacePath(loaded.filename);
      if (sourcePath) add("server:process", sourcePath);
    }
  }

  const cloned = new Map<OrchestratorReloadScope, GraphNode>();
  const clone = (node: GraphNode): GraphNode => {
    const current = cloned.get(node.scope);
    if (current) return current;
    const next = cloneGraphNode(
      node,
      [...(pathsByScope.get(node.scope) ?? [])].sort(),
      (node.children as readonly GraphNode[]).map(clone),
    );
    cloned.set(node.scope, next);
    return next;
  };
  const clonedRoots = originalRoots.map(clone);
  const descriptors: ReloadNodeSourceDescriptor[] = [...nodes.values()].map((node) => ({
    access: node.access,
    boundaryPatterns: readSourcePatterns(node.boundarySources),
    description: node.description,
    destructive: DESTRUCTIVE_SCOPES.has(node.scope),
    paths: [...(pathsByScope.get(node.scope) ?? [])].sort(),
    safeAll: node.safeAll,
    scope: node.scope,
  }));
  descriptors.push({
    access: "operator",
    description: "Restart the complete orchestrator process.",
    destructive: true,
    paths: [...(pathsByScope.get("server:process") ?? [])].sort(),
    safeAll: false,
    scope: "server:process",
  });
  const children = new Map<OrchestratorReloadScope, Set<OrchestratorReloadScope>>();
  for (const [scope, scopeParents] of parents) for (const parent of scopeParents) {
    (children.get(parent) ?? children.set(parent, new Set()).get(parent)!).add(scope);
  }
  sourceRegistry().pending = {
    dependantClosure(scopes) {
      const selected = new Set(scopes);
      const visit = (scope: OrchestratorReloadScope) => {
        for (const child of children.get(scope) ?? []) if (!selected.has(child)) {
          selected.add(child);
          visit(child);
        }
      };
      for (const scope of [...selected]) visit(scope);
      return descriptors.map(({ scope }) => scope).filter((scope) => selected.has(scope));
    },
    descriptors,
  };
  return Object.freeze({ roots: Object.freeze(clonedRoots) }) as ReloadableNodeGraph<TContext, TObjects, TNotification>;
}

export function readReloadNodeSourceState() {
  const registry = sourceRegistry();
  if (!registry.active && registry.pending) {
    registry.active = registry.pending;
    registry.pending = null;
  }
  if (!registry.active) throw new Error("Reload node source metadata is not loaded.");
  return registry.active;
}

export function activateReloadNodeSourceState() {
  const registry = sourceRegistry();
  if (!registry.pending) throw new Error("No candidate reload node source metadata is available.");
  registry.active = registry.pending;
  registry.pending = null;
  return registry.active;
}

export function cancelReloadNodeSourceState() {
  sourceRegistry().pending = null;
}
