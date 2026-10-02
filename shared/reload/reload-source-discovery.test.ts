/*
 * No production exports. Tests protect import-derived ownership and repository boundaries.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import { discoverReloadGraphSources } from "./reload-source-discovery";

const repoRoot = path.resolve("source-fixture");

function moduleAt(relative: string, children: NodeModule[] = [], exports: object = {}) {
  return { filename: path.resolve(repoRoot, relative), children, exports } as NodeModule;
}

function node(scope: string, children: ReloadableNode<object, object, never>[] = [], entries: string[] = []) {
  return ReloadableNode.define<object, object, never>()({
    scope, children, entries, access: "agent", description: scope, lifecycle: "atomic",
    provides: [] as const, requires: [] as const, safeAll: true,
    create: () => ({ registrations: {}, start() {}, dispose() {} }),
  });
}

test("out-of-process entries contribute their resolved import closure to the declaring node", () => {
  const worker = path.join(repoRoot, "daemon/worker.mjs");
  const owner = node("server:owner", [], [worker]);
  const ownerModule = moduleAt("daemon/owner.ts", [], { default: owner });
  const root = moduleAt("daemon/root.ts", [ownerModule]);
  const graph = defineReloadableNodeGraph([owner]);
  const result = discoverReloadGraphSources(graph, root, {
    repoRoot, modules: [ownerModule],
    resolveEntryImports: entries => [...entries, path.join(repoRoot, "daemon/worker-schema.ts"), path.join(repoRoot, "daemon/worker.test.ts")],
  });
  assert.deepEqual(result.sourceMetadata?.pathsByScope.get("server:owner"), [
    "daemon/owner.ts", "daemon/worker-schema.ts", "daemon/worker.mjs",
  ]);
  assert.throws(() => discoverReloadGraphSources(graph, root, { repoRoot, modules: [ownerModule] }), /cannot resolve entry imports/u);
});

test("shared imports belong to their consumer without absorbing a child node", () => {
  const child = node("client:child");
  const parent = node("client:parent", [child]);
  const shared = moduleAt("shared/dependency.ts");
  const childModule = moduleAt("app/child.ts", [shared], { default: child });
  const parentModule = moduleAt("app/parent.ts", [childModule, shared], { default: parent });
  const root = moduleAt("app/root.ts", [parentModule]);
  const result = discoverReloadGraphSources(defineReloadableNodeGraph([parent]), root, {
    repoRoot, modules: [parentModule, childModule, shared],
  });
  assert.deepEqual(result.sourceMetadata?.pathsByScope.get("client:parent"), ["app/parent.ts", "shared/dependency.ts"]);
  assert.deepEqual(result.sourceMetadata?.pathsByScope.get("client:child"), ["app/child.ts", "shared/dependency.ts"]);
  assert.deepEqual(result.sourceMetadata?.topologyPaths, ["app/child.ts", "app/parent.ts", "app/root.ts"]);
});

test("process imports survive graph generations without including retired graphs or outside paths", () => {
  const owner = node("server:owner");
  const shared = moduleAt("shared/reload/kernel.ts");
  const ownerModule = moduleAt("daemon/owner.ts", [shared], { default: owner });
  const root = moduleAt("daemon/root.ts", [ownerModule]);
  const retired = moduleAt("daemon/root.ts", [moduleAt("daemon/retired.ts")]);
  const outside = moduleAt("../outside/daemon/lookalike.ts");
  const dependency = moduleAt("node_modules/package/index.ts");
  const testModule = moduleAt("daemon/ignored.test.ts");
  const processModule = moduleAt("daemon/index.ts", [retired, root, shared, outside, dependency, testModule]);
  const discover = () => discoverReloadGraphSources(defineReloadableNodeGraph([owner]), root, {
    repoRoot, modules: [ownerModule, shared], processModule,
  });
  assert.deepEqual(discover().sourceMetadata?.processPaths, ["daemon/index.ts", "shared/reload/kernel.ts"]);
  root.children = [moduleAt("daemon/owner.ts", [], { default: owner })];
  assert.deepEqual(discover().sourceMetadata?.processPaths, ["daemon/index.ts", "shared/reload/kernel.ts"]);
});

test("scoped observations join their generation without crossing repository ownership", () => {
  const owner = node("server:instructions");
  const ownerModule = moduleAt("daemon/instructions.ts", [], { default: owner });
  const root = moduleAt("daemon/root.ts", [ownerModule]);
  const graph = {
    ...defineReloadableNodeGraph([owner]),
    sourceObservations: [
      { scope: "server:instructions", path: path.join(repoRoot, "instructions/AGENTS.md") },
      { scope: "server:instructions", path: path.resolve(repoRoot, "../outside/secret.md") },
    ],
  };
  const result = discoverReloadGraphSources(graph, root, { repoRoot, modules: [ownerModule] });
  assert.deepEqual(result.sourceMetadata?.pathsByScope.get("server:instructions"), [
    "daemon/instructions.ts", "instructions/AGENTS.md",
  ]);
});
