import assert from "node:assert/strict";
import test from "node:test";
import { schemaMigrationBetween } from "./reload-schema-manifest.ts";

const manifest = { path: "releases.ts", label: "database" };
const releases = (...versions: number[]) =>
  `const releases = Object.freeze({\n${versions.map(version => `  step${version}: release(${version}, null),`).join("\n")}\n});`;

test("a manifest gaining a newer release migrates from the loaded newest to the next newest", () => {
  assert.deepEqual(schemaMigrationBetween(manifest, releases(1, 2, 30), releases(1, 2, 30, 31, 32)),
    { label: "database", from: 30, to: 32 });
});

test("edits that add no newer release, or remove the manifest, do not migrate", () => {
  assert.equal(schemaMigrationBetween(manifest, releases(1, 30), releases(1, 30).replace("null", "\"sealed\"")), null);
  assert.equal(schemaMigrationBetween(manifest, releases(1, 30), releases(1, 29)), null);
  assert.equal(schemaMigrationBetween(manifest, releases(1, 30), null), null);
  assert.equal(schemaMigrationBetween(manifest, null, releases(1, 30)), null);
});
