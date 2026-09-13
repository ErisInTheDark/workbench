/* No exports. Tests protect companion ownership and complete orphan reporting. */
import assert from "node:assert/strict";
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
