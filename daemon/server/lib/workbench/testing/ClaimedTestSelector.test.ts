/* No exports. Tests protect claim-directed impact without unrelated dependency expansion. */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import ProjectTestCatalog from "../../../../../test/ProjectTestCatalog";
import ProjectImportGraph from "../ProjectImportGraph";
import ClaimedTestSelector from "./ClaimedTestSelector";

test("selects affected consumers and reload boundaries without unrelated dependencies", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("claimed-tests-");
  const root = temporary.path;
  const file = (name: string) => path.join(root, name);
  try {
    const contents = {
      "Parent.ts": 'import "./input"; import "./Child";',
      "Child.ts": 'import "./child-input";',
      "input.ts": "export const input = 1",
      "child-input.ts": "export const input = 2",
      "outside.ts": 'import "./unchanged";',
      "consumer.ts": 'import "./outside";',
      "outer-consumer.ts": 'import "./consumer"; import "./unchanged";',
      "unchanged.ts": "export const value = 3",
      "unrelated.ts": "export const value = 4",
      "worker.ts": 'import "./worker-input";',
      "worker-input.ts": "export const value = 5",
      "cross-owner.ts": "export const value = 6",
    };
    const names = Object.keys(contents);
    await Promise.all(Object.entries(contents).map(([name, value]) => writeFile(file(name), value)));
    const tests = names.map(name => name.replace(".ts", ".test.ts"));
    await Promise.all(tests.map(name => writeFile(file(name), "")));
    await writeFile(file("cross-owner.test.ts"), 'import "./input";');
    const catalog = await ProjectTestCatalog.read(root);
    const child = { scope: "child", children: [] };
    const parent = { scope: "parent", entries: [file("worker.ts")], children: [child] };
    const selector = new ClaimedTestSelector(catalog, new ProjectImportGraph(root, catalog.files), [parent],
      new Map([["parent", file("Parent.ts")], ["child", file("Child.ts")]]));
    assert.deepEqual(selector.select(["input.ts"]).files, ["Child.test.ts", "Parent.test.ts", "input.test.ts", "cross-owner.test.ts"].map(file).sort());
    assert.deepEqual(selector.select(["worker.ts"]).files, ["Child.test.ts", "Parent.test.ts", "worker.test.ts"].map(file).sort());
    assert.deepEqual(selector.select(["worker-input.ts"]).files, ["Child.test.ts", "Parent.test.ts", "worker-input.test.ts", "worker.test.ts"].map(file).sort());
    assert.deepEqual(selector.select(["outside.ts"]).files, ["consumer.test.ts", "outer-consumer.test.ts", "outside.test.ts"].map(file));
    assert.deepEqual(selector.select(["Child.ts"]).scopes, ["child"]);
    assert.deepEqual(selector.select(["outside.test.ts"]).files, [file("outside.test.ts")]);
    assert.deepEqual(selector.select(["."]).files, tests.map(file).sort());
    assert.deepEqual(selector.select(["deleted.ts", "outside.ts"]).files, ["consumer.test.ts", "outer-consumer.test.ts", "outside.test.ts"].map(file));
    assert.throws(() => selector.select([]), /No live/);
    assert.throws(() => selector.select(["../escape.ts"]), /escapes/);
  } finally {
    await temporary.dispose();
  }
});

test("loads project reload definitions without starting their services and selects real companions", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const catalog = await ProjectTestCatalog.read(root);
  const selector = await ClaimedTestSelector.load(catalog);
  const owner = path.join(root, "daemon/server/CodexStdioBridge.ts");
  const selection = selector.select([path.relative(root, owner)]);
  assert.ok(selection.scopes.length > 0);
  for (const companion of catalog.companions([owner])) assert.ok(selection.files.includes(companion));
  assert.ok(selection.files.length < catalog.tests.length);
  const transcript = selector.select([
    "daemon/server/database/transcript/WorkbenchTranscriptRepository.ts",
    "shared/codex/thread-state.ts",
  ]);
  for (const companion of catalog.companions([path.join(root, "daemon/server/database/transcript/WorkbenchTranscriptRepository.ts")])) {
    assert.ok(transcript.files.includes(companion));
  }
  const checkpoint = "daemon/server/lib/workbench/git/WorkbenchGitCheckpointController.ts";
  const checkpointSelection = selector.select([checkpoint]);
  for (const companion of catalog.companions([path.join(root, checkpoint)])) {
    assert.ok(!transcript.files.includes(companion), `Unrelated checkpoint battery selected: ${companion}`);
    assert.ok(checkpointSelection.files.includes(companion), `Claimed checkpoint battery omitted: ${companion}`);
  }
  const bridgeSelection = selector.select(["daemon/server/providers/opencode/OpenCodeBridgeNode.ts"]);
  for (const companion of catalog.companions([path.join(root, "daemon/server/daemon-root-node.ts")])) {
    assert.ok(bridgeSelection.files.includes(companion), `Production graph validation omitted: ${companion}`);
  }
  const skillSelection = selector.select(["daemon/server/lib/workbench/commands/skill-command-definition.ts"]);
  assert.ok(skillSelection.files.includes(path.join(root, "app/client/workbench/thread/thread-command-matchers.test.ts")));
  assert.ok(!skillSelection.files.includes(path.join(root, "app/client/workbench/thread/inline-mention-highlights.skills.test.ts")));
});
