/* No exports. Tests distinguish node-wide imports from outside-node transitive importers. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ProjectTestCatalog from "../../../../test/ProjectTestCatalog";
import ProjectImportGraph from "./ProjectImportGraph";
import ClaimedTestSelector from "./ClaimedTestSelector";

test("selects whole affected nodes but only consumers for outside-node claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claimed-tests-"));
  const file = (name: string) => path.join(root, name);
  try {
    const contents = {
      "Parent.ts": 'import "./input"; import "./Child";',
      "Child.ts": 'import "./child-input";',
      "input.ts": "export const input = 1",
      "child-input.ts": "export const input = 2",
      "outside.ts": 'import "./unchanged";',
      "consumer.ts": 'import "./outside";',
      "unchanged.ts": "export const value = 3",
      "unrelated.ts": "export const value = 4",
    };
    const names = Object.keys(contents);
    await Promise.all(Object.entries(contents).map(([name, value]) => writeFile(file(name), value)));
    const tests = names.map(name => name.replace(".ts", ".test.ts"));
    await Promise.all(tests.map(name => writeFile(file(name), "")));
    const catalog = await ProjectTestCatalog.read(root);
    const child = { scope: "child", sources: "Child.ts", children: [] };
    const parent = { scope: "parent", sources: "Parent.ts", children: [child] };
    const selector = new ClaimedTestSelector(catalog, new ProjectImportGraph(root, catalog.sources), [parent],
      new Map([["parent", file("Parent.ts")], ["child", file("Child.ts")]]));
    assert.deepEqual(selector.select(["input.ts"]).files, ["Child.test.ts", "Parent.test.ts", "child-input.test.ts", "input.test.ts"].map(file).sort());
    assert.deepEqual(selector.select(["outside.ts"]).files, ["consumer.test.ts", "outside.test.ts"].map(file));
    assert.deepEqual(selector.select(["Child.ts"]).scopes, ["child"]);
    assert.deepEqual(selector.select(["outside.test.ts"]).files, [file("outside.test.ts")]);
    assert.deepEqual(selector.select(["."]).files, tests.map(file).sort());
    assert.throws(() => selector.select(["deleted.ts"]), /cannot be mapped/);
    assert.throws(() => selector.select([]), /No live/);
    assert.throws(() => selector.select(["../escape.ts"]), /escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads project reload definitions without starting their services and selects real companions", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const catalog = await ProjectTestCatalog.read(root);
  const selector = await ClaimedTestSelector.load(catalog);
  const owner = path.join(root, "daemon/orchestrator/opencode-bridge.ts");
  const selection = selector.select([path.relative(root, owner)]);
  assert.ok(selection.scopes.length > 0);
  for (const companion of catalog.companions([owner])) assert.ok(selection.files.includes(companion));
  assert.ok(selection.files.length < catalog.tests.length);
  const outside = path.join(root, "wb");
  assert.deepEqual(selector.select(["wb"]).files, catalog.companions([outside]));
});
