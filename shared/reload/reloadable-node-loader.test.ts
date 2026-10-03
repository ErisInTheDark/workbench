/* No production exports. Protect retired reload generations from staying reachable through Node's module graph. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReloadableNodeModuleLoader } from "./reloadable-node-loader.ts";

function reachableModules(root: NodeModule) {
  const reached = new Set<NodeModule>();
  const visit = (current: NodeModule) => {
    if (reached.has(current)) return;
    reached.add(current);
    current.children.forEach(visit);
  };
  visit(root);
  return reached;
}

test("reloads leave no path from surviving modules to retired generations", context => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-reload-loader-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  // `host` stands in for the non-reloadable loader module: it parents the graph root and shares a helper with it.
  writeFileSync(path.join(directory, "shared.cjs"), "exports.value = {};\n");
  writeFileSync(path.join(directory, "feature.cjs"), "require('./shared.cjs');\nexports.payload = new Array(8).fill('generation');\n");
  writeFileSync(path.join(directory, "root.cjs"), "require('./feature.cjs');\nrequire('./shared.cjs');\nexports.default = { roots: [] };\n");
  writeFileSync(path.join(directory, "host.cjs"), "require('./shared.cjs');\nmodule.exports = { require, module };\n");
  const outer = createRequire(path.join(directory, "entry.cjs"));
  const host = outer("./host.cjs") as { require: NodeRequire; module: NodeModule };
  context.after(() => {
    for (const id of Object.keys(host.require.cache)) if (id.startsWith(directory)) delete host.require.cache[id];
  });
  const loader = createReloadableNodeModuleLoader<unknown, object, unknown>(host.require, "./root.cjs");

  loader.load();
  for (let generation = 0; generation < 3; generation++) loader.reload();

  const cache = host.require.cache;
  const retired = [...reachableModules(host.module)].filter(module => cache[module.id] !== module);
  assert.deepEqual(retired.map(module => path.basename(module.id)), [],
    "surviving modules must only reach the current generation");
  const rootId = host.require.resolve("./root.cjs");
  assert.equal(host.module.children.filter(child => child.id === rootId).length, 1);
});
