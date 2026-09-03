/*
 * No production exports. Tests protect generated path hygiene, root instruction ownership, destructive classification, and retired module-generation boundaries. Keywords: reload, source map, paths, instructions, destructive, generation, test.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import graph from "./orchestrator-root-node";
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
      assert.match(sourcePath, /^(?:instructions|webapp)\//u, `${descriptor.scope} source escaped Workbench`);
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
  const rootModule = require.cache[require.resolve("./orchestrator-root-node")];
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
    assert.equal(processDescriptor.paths.includes("webapp/orchestrator/retired-graph-generation.ts"), false);
  } finally {
    const index = mainModule.children.indexOf(retiredRoot);
    if (index >= 0) mainModule.children.splice(index, 1);
    cancelReloadNodeSourceState();
  }
});
