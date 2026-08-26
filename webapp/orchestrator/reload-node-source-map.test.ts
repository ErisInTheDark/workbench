/*
 * No production exports. Tests protect generated source-map path hygiene and destructive classification. Keywords: reload, source map, paths, destructive, test.
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
      assert.match(sourcePath, /^webapp\//u, `${descriptor.scope} source escaped webapp`);
    }
  }
  assert.deepEqual(
    descriptors.filter(({ destructive }) => destructive).map(({ scope }) => scope).sort(),
    ["harness:codex", "harness:opencode", "server:process"],
  );
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
