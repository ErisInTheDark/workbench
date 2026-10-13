/* No exports. Tests protect companion ownership and complete orphan reporting. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import test from "node:test";
import ProjectTestCatalog from "./ProjectTestCatalog";

test("matches batteries to source owners without including unrelated neighbours", () => {
  const root = path.resolve("catalog");
  const names = [
    "Foo.ts", "Foo.test.ts", "Foo.failure.test.tsx", "Other.ts", "Other.test.ts",
    "globals.css", "globals.modifiers.test.ts", "wb", "wb.test.ts", "nested/Foo.test.ts",
  ];
  const file = (name: string) => path.join(root, name);
  const catalog = new ProjectTestCatalog(root, names.map(file));
  assert.deepEqual(catalog.companions([file("Foo.ts")]), ["Foo.failure.test.tsx", "Foo.test.ts"].map(file));
  assert.deepEqual(catalog.owners.get(file("globals.modifiers.test.ts")), [file("globals.css")]);
  assert.deepEqual(catalog.owners.get(file("wb.test.ts")), [file("wb")]);
  assert.throws(() => catalog.validate(), /nested[/\\]Foo\.test\.ts/);
  assert.deepEqual(catalog.select(["Foo.test.ts", "Foo.test.ts"]), [file("Foo.test.ts")]);
});

test("scenario tests require exact selection without hiding ordinary sibling tests", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-test-catalog-");
  const root = temporary.path;
  try {
    const scenarios = path.join(root, "test", "scenarios");
    await mkdir(scenarios, { recursive: true });
    const requested = path.join(scenarios, "lifecycle.scenario.test.ts");
    const ordinary = path.join(scenarios, "IsolatedWorkbench.test.ts");
    await Promise.all([
      writeFile(requested, ""),
      writeFile(path.join(scenarios, "thread.scenario.test.ts"), ""),
      writeFile(path.join(scenarios, "lifecycle-fixture.ts"), ""),
      writeFile(path.join(scenarios, "IsolatedWorkbench.ts"), ""),
      writeFile(ordinary, ""),
    ]);
    const defaultCatalog = await ProjectTestCatalog.read(root);
    assert.doesNotThrow(() => defaultCatalog.validate());
    assert.deepEqual(defaultCatalog.select(), [ordinary]);
    const catalog = await ProjectTestCatalog.read(root, ["test/scenarios/lifecycle.scenario.test.ts"]);
    assert.doesNotThrow(() => catalog.validate());
    assert.deepEqual(catalog.select(["test/scenarios/lifecycle.scenario.test.ts"]), [requested]);
    assert.equal(catalog.tests.some(file => file.endsWith("thread.scenario.test.ts")), false);
  } finally {
    await temporary.dispose();
  }
});

test("discovers CLI and script tests with nested installation owners while preserving exclusions", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-operational-tests-");
  context.after(() => temporary.dispose());
  const file = (name: string) => path.join(temporary.path, name);
  const owners = ["cli/Command.mjs", "scripts/publish.mjs", "scripts/installation/Installer.mjs"];
  const tests = owners.map(owner => owner.replace(/\.mjs$/u, ".test.ts"));
  for (const name of [
    ...owners, ...tests, "scripts/installation/Installer.scenario.test.ts",
    "scripts/node_modules/dependency/Unowned.test.ts",
  ]) {
    await mkdir(path.dirname(file(name)), { recursive: true });
    await writeFile(file(name), "");
  }
  const catalog = await ProjectTestCatalog.read(temporary.path);
  assert.doesNotThrow(() => catalog.validate());
  assert.deepEqual(catalog.select(), tests.map(file).sort());
  assert.deepEqual(catalog.companions(owners.map(file)), tests.map(file).sort());
  assert.deepEqual(catalog.select(["scripts/installation"]), [file("scripts/installation/Installer.test.ts")]);

  await writeFile(file("scripts/installation/Unowned.test.ts"), "");
  const invalid = await ProjectTestCatalog.read(temporary.path);
  assert.throws(() => invalid.validate(), /Unowned\.test\.ts/u);
});
