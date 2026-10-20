/* No production exports. Protect retired reload generations from staying reachable, and unchanged shareable modules staying shared only while nothing beneath them changed. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createReloadableNodeModuleLoader, type ReloadModuleSharing } from "./reloadable-node-loader.ts";

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

/** `host` stands in for the non-reloadable loader module that parents the graph root. */
function moduleGraph(context: TestContext, files: Record<string, string>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-reload-loader-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries({ ...files, "host.cjs": `${files["host.cjs"] ?? ""}module.exports = { require, module };\n` })) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), source);
  }
  const host = createRequire(path.join(directory, "entry.cjs"))("./host.cjs") as { require: NodeRequire; module: NodeModule };
  context.after(() => {
    for (const id of Object.keys(host.require.cache)) if (id.startsWith(directory)) delete host.require.cache[id];
  });
  return {
    directory,
    host,
    exportsOf: (name: string) => host.require.cache[host.require.resolve(`./${name}`)]!.exports as object,
  };
}

for (const sharing of [undefined, { shareable: (filename: string) => path.basename(filename) === "shared.cjs" }]) {
  test(`reloads leave no path from surviving modules to retired generations${sharing ? " while sharing a module" : ""}`, context => {
    const { host } = moduleGraph(context, {
      "shared.cjs": "exports.value = {};\n",
      "feature.cjs": "require('./shared.cjs');\nexports.payload = new Array(8).fill('generation');\n",
      "root.cjs": "require('./feature.cjs');\nrequire('./shared.cjs');\nexports.default = { roots: [] };\n",
      "host.cjs": "require('./shared.cjs');\n",
    });
    const loader = createReloadableNodeModuleLoader<unknown, object, unknown>(host.require, "./root.cjs", undefined, sharing);

    loader.load();
    for (let generation = 0; generation < 3; generation++) loader.reload();

    const cache = host.require.cache;
    const retired = [...reachableModules(host.module)].filter(module => cache[module.id] !== module);
    assert.deepEqual(retired.map(module => path.basename(module.id)), [],
      "surviving modules must only reach the current generation");
    const rootId = host.require.resolve("./root.cjs");
    assert.equal(host.module.children.filter(child => child.id === rootId).length, 1);
  });
}

const sharedOnly = (directory: string): ReloadModuleSharing => ({
  shareable: filename => path.dirname(filename) === path.join(directory, "shared"),
});

test("a reload keeps unchanged shareable modules and re-evaluates a changed one with everything importing it", context => {
  const { directory, host, exportsOf } = moduleGraph(context, {
    "shared/contract.cjs": "exports.value = {};\n",
    "shared/changed.cjs": "exports.value = {};\n",
    "shared/uses-changed.cjs": "require('./changed.cjs');\nexports.value = {};\n",
    "feature.cjs": "require('./shared/contract.cjs');\nrequire('./shared/uses-changed.cjs');\nexports.value = {};\n",
    "root.cjs": "require('./feature.cjs');\nexports.default = { roots: [] };\n",
  });
  const loader = createReloadableNodeModuleLoader<unknown, object, unknown>(host.require, "./root.cjs", undefined, sharedOnly(directory));
  loader.load();
  const names = ["shared/contract.cjs", "shared/changed.cjs", "shared/uses-changed.cjs", "feature.cjs", "root.cjs"];
  const before = new Map(names.map(name => [name, exportsOf(name)]));

  writeFileSync(path.join(directory, "shared/changed.cjs"), "exports.value = { edited: true };\n");
  loader.reload();

  assert.deepEqual(names.filter(name => exportsOf(name) === before.get(name)), ["shared/contract.cjs"],
    "only the unchanged shareable module whose imports are all unchanged may stay");
});

test("a shareable source edited while a load runs is re-evaluated by the next reload", context => {
  const { directory, host, exportsOf } = moduleGraph(context, {
    "shared/contract.cjs": "exports.value = {};\n",
    "root.cjs": "require('./shared/contract.cjs');\nexports.default = { roots: [] };\n",
  });
  // A modification time after the load began is what an edit racing the load leaves behind.
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(directory, "shared/contract.cjs"), later, later);
  const loader = createReloadableNodeModuleLoader<unknown, object, unknown>(host.require, "./root.cjs", undefined, sharedOnly(directory));
  loader.load();
  const before = exportsOf("shared/contract.cjs");

  loader.reload();

  assert.notEqual(exportsOf("shared/contract.cjs"), before, "the copy may predate the edit, so it must not be kept");
});
