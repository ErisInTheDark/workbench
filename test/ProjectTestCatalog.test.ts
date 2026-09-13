/* No exports. Tests protect companion ownership and complete orphan reporting. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("explicit standalone diagnostics do not discover or validate sibling tests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-test-catalog-"));
  try {
    const diagnostics = path.join(root, "diagnostics");
    await mkdir(diagnostics);
    const requested = path.join(diagnostics, "workbench-lifecycle.test.ts");
    await Promise.all([
      writeFile(requested, ""),
      writeFile(path.join(diagnostics, "workbench-codex.test.ts"), ""),
      writeFile(path.join(diagnostics, "lifecycle-fixture.ts"), ""),
    ]);
    const catalog = await ProjectTestCatalog.read(root, ["diagnostics/workbench-lifecycle.test.ts"]);
    assert.doesNotThrow(() => catalog.validate());
    assert.deepEqual(catalog.select(["diagnostics/workbench-lifecycle.test.ts"]), [requested]);
    assert.equal(catalog.tests.some(file => file.endsWith("workbench-codex.test.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
