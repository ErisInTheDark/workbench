/*
 * No production exports. Tests protect generated path hygiene, root instruction ownership, destructive classification, and retired module-generation boundaries.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import graph from "./daemon-root-node";
import ReloadableNode from "./ReloadableNode";
import {
  activateReloadNodeSourceState,
  cancelReloadNodeSourceState,
  observeReloadNodeGraphSources,
  readReloadNodeSourceState,
} from "./reload-node-source-map";

test("generated reload sources are exact workspace paths with explicit destructive scopes", () => {
  const { descriptors } = readReloadNodeSourceState();
  for (const descriptor of descriptors) {
    assert.deepEqual(descriptor.paths, [...new Set(descriptor.paths)].sort(), `${descriptor.scope} paths must be sorted and unique`);
    for (const sourcePath of descriptor.paths) {
      assert.equal(path.isAbsolute(sourcePath), false, `${descriptor.scope} leaked an absolute path`);
      assert.equal(sourcePath.includes("node_modules/"), false, `${descriptor.scope} absorbed node_modules`);
      assert.equal(sourcePath.split("/").includes(".."), false, `${descriptor.scope} source escaped Workbench`);
    }
  }
  assert.deepEqual(
    descriptors.filter(({ destructive }) => destructive).map(({ scope }) => scope).sort(),
    ["harness:codex", "harness:opencode", "server:process"],
  );
});

test("root instruction reads belong to the instruction reload scope", () => {
  const instructionPath = path.resolve(__dirname, "../..", "instructions", "AGENTS.md");
  observeReloadNodeGraphSources(graph, module, [instructionPath]);
  const sourceState = activateReloadNodeSourceState();
  const instructionDescriptor = sourceState.descriptors.find(({ scope }) => scope === "server:instructions");
  assert.ok(instructionDescriptor);
  assert.equal(instructionDescriptor.paths.includes("instructions/AGENTS.md"), true);
});

test("failed candidates cannot replace the active source generation", () => {
  const active = readReloadNodeSourceState();
  observeReloadNodeGraphSources(graph, module, []);
  cancelReloadNodeSourceState();
  assert.equal(readReloadNodeSourceState(), active);

  observeReloadNodeGraphSources(graph, module, []);
  const promoted = activateReloadNodeSourceState();
  assert.notEqual(promoted, active);
  assert.equal(readReloadNodeSourceState(), promoted);
});

test("retired graph generations stay behind the active root source boundary", () => {
  const mainModule = require.main;
  const rootModule = require.cache[require.resolve("./daemon-root-node")];
  assert.ok(mainModule);
  assert.ok(rootModule);
  const retiredSourcePath = path.join(path.dirname(rootModule.filename), "retired-graph-generation.ts");
  const retiredRoot = {
    children: [{ children: [], filename: retiredSourcePath }],
    filename: rootModule.filename,
  } as NodeModule;
  mainModule.children.push(retiredRoot);

  try {
    observeReloadNodeGraphSources(graph, rootModule, []);
    const sourceState = activateReloadNodeSourceState();
    const processDescriptor = sourceState.descriptors.find(({ scope }) => scope === "server:process");
    assert.ok(processDescriptor);
    assert.equal(processDescriptor.paths.includes("daemon/server/retired-graph-generation.ts"), false);
  } finally {
    const index = mainModule.children.indexOf(retiredRoot);
    if (index >= 0) mainModule.children.splice(index, 1);
    cancelReloadNodeSourceState();
  }
});

test("a direct process dependency remains process-owned across graph module generations", () => {
  const mainModule = require.main;
  const rootModule = require.cache[require.resolve("./daemon-root-node")];
  assert.ok(mainModule);
  assert.ok(rootModule);
  const filename = path.join(path.dirname(rootModule.filename), "shared-process-dependency.ts");
  const sharedModule = { children: [], filename } as NodeModule;
  const nextModule = { children: [], filename } as NodeModule;
  mainModule.children.push(sharedModule);
  rootModule.children.push(sharedModule);
  const readProcessOwnership = () => {
    observeReloadNodeGraphSources(graph, rootModule, []);
    return activateReloadNodeSourceState().descriptors
      .find(({ scope }) => scope === "server:process")!.paths
      .includes("daemon/server/shared-process-dependency.ts");
  };
  try {
    assert.equal(readProcessOwnership(), true, "a direct process import exists before the first reload");
    rootModule.children.splice(rootModule.children.indexOf(sharedModule), 1, nextModule);
    assert.equal(readProcessOwnership(), true, "changing graph module identity must not discover new process ownership");
  } finally {
    mainModule.children.splice(mainModule.children.indexOf(sharedModule), 1);
    const rootIndex = rootModule.children.findIndex((child) => child === sharedModule || child === nextModule);
    if (rootIndex >= 0) rootModule.children.splice(rootIndex, 1);
    observeReloadNodeGraphSources(graph, rootModule, []);
    activateReloadNodeSourceState();
  }
});

test("shared process dependencies survive graph generations without admitting outside-root lookalikes", () => {
  const mainModule = require.main;
  const rootModule = require.cache[require.resolve("./daemon-root-node")];
  assert.ok(mainModule);
  assert.ok(rootModule);
  const workspace = path.resolve(__dirname, "../..");
  const shared = { children: [], filename: path.join(workspace, "shared/reload/ReloadableNodeHost.ts") } as unknown as NodeModule;
  const outside = { children: [], filename: path.join(workspace, "../outside/daemon/not-workbench.ts") } as unknown as NodeModule;
  const dependency = { children: [], filename: path.join(workspace, "node_modules/example/daemon/dependency.ts") } as unknown as NodeModule;
  mainModule.children.push(shared, outside, dependency);
  rootModule.children.push(shared);
  const readPaths = () => {
    observeReloadNodeGraphSources(graph, rootModule, []);
    return activateReloadNodeSourceState().descriptors.find(({ scope }) => scope === "server:process")!.paths;
  };
  try {
    const first = readPaths();
    assert.equal(first.includes("shared/reload/ReloadableNodeHost.ts"), true);
    assert.equal(first.some(value => value.includes("not-workbench.ts") || value.includes("dependency.ts")), false);
    rootModule.children.splice(rootModule.children.indexOf(shared), 1);
    assert.equal(readPaths().includes("shared/reload/ReloadableNodeHost.ts"), true);
  } finally {
    for (const added of [shared, outside, dependency]) {
      mainModule.children.splice(mainModule.children.indexOf(added), 1);
    }
    const index = rootModule.children.indexOf(shared);
    if (index >= 0) rootModule.children.splice(index, 1);
    observeReloadNodeGraphSources(graph, rootModule, []);
    activateReloadNodeSourceState();
  }
});

test("a node retains ownership of its loaded shared dependencies", () => {
  const workspace = path.resolve(__dirname, "../..");
  const filename = path.join(__dirname, "source-map-fixture.ts");
  const previous = require.cache[filename];
  const node = new ReloadableNode<object, object, never>({
    scope: "server:fixture", access: "agent", children: [], requires: [] as const, provides: [] as const,
    lifecycle: "atomic", safeAll: true, description: "fixture", sources: "",
    create: () => ({ registrations: {}, start() {}, dispose() {} }),
  });
  const nodeModule = {
    filename, exports: { default: node },
    children: [{ children: [], filename: path.join(workspace, "shared/fixture-dependency.ts") }],
  } as unknown as NodeModule;
  require.cache[filename] = nodeModule;
  const rootModule = { filename: path.join(__dirname, "source-map-root.ts"), children: [nodeModule] } as unknown as NodeModule;
  try {
    observeReloadNodeGraphSources({ roots: [node] }, rootModule, []);
    const descriptor = activateReloadNodeSourceState().descriptors.find(({ scope }) => scope === "server:fixture");
    assert.equal(descriptor?.paths.includes("shared/fixture-dependency.ts"), true);
  } finally {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
    observeReloadNodeGraphSources(graph, module, []);
    activateReloadNodeSourceState();
  }
});
