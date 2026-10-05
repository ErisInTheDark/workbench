/* No production exports. Protect source-tracked modules: reuse while unchanged, reload after edits, never leak retired generations. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceTrackedModule } from "./require-cache-generations.ts";

function reachableModules(root: NodeModule) {
  const reached = new Set<NodeModule>();
  const visit = (current: NodeModule) => {
    if (reached.has(current)) return;
    reached.add(current);
    current.children.forEach(visit);
    // Node keeps each module's first parent for life; packages loaded once must not pin the generation that loaded them.
    if (current.parent) visit(current.parent);
  };
  visit(root);
  return reached;
}

test("source-tracked modules reload only after an edit and release the retired generation", async context => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-source-tracked-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  // Settled mtimes, distinct per write, keep the loader from treating fixtures as edited mid-load.
  const write = (name: string, content: string, ageMs: number) => {
    const file = path.join(directory, name);
    writeFileSync(file, content);
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
  };
  write("feature.cjs", "exports.version = 1;\n", 60_000);
  mkdirSync(path.join(directory, "node_modules", "pkg"), { recursive: true });
  write(path.join("node_modules", "pkg", "index.cjs"), "exports.ok = true;\n", 60_000);
  write("root.cjs", "exports.feature = require('./feature.cjs');\nrequire('./node_modules/pkg/index.cjs');\n", 60_000);
  // `host` stands in for the long-lived module that owns the tracked loader.
  write("host.cjs", "module.exports = { require, module };\n", 60_000);
  const outer = createRequire(path.join(directory, "entry.cjs"));
  const host = outer("./host.cjs") as { require: NodeRequire; module: NodeModule };
  context.after(() => {
    for (const id of Object.keys(host.require.cache)) if (id.startsWith(directory)) delete host.require.cache[id];
  });
  const rootId = host.require.resolve("./root.cjs");
  const tracked = createSourceTrackedModule<{ feature: { version: number } }>(host.require, rootId);

  const first = await tracked.load();
  assert.equal(await tracked.load(), first, "unchanged sources reuse the loaded generation");

  write("feature.cjs", "exports.version = 2;\n", 30_000);
  const edited = await tracked.load();
  assert.notEqual(edited, first);
  assert.equal(edited.feature.version, 2);

  const cache = host.require.cache;
  const retired = [...reachableModules(host.module)]
    // `loaded` skips createRequire's synthetic entry parent, which was never a cached module.
    .filter(module => module.loaded && cache[module.id] !== module);
  assert.deepEqual(retired.map(module => path.basename(module.id)), [],
    "the owning module must only reach the current generation");
  assert.equal(host.module.children.filter(child => child.id === rootId).length, 1);
});
