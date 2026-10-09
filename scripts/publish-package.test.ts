/*
 * No production exports. Protects release version selection, confirmation and generated package README content.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { preparePackagePublication, preparePackageVersion, runPackagePublication } from "./publish-package.mjs";

async function writeManifest(root: string, version: string) {
  await fs.mkdir(path.join(root, "package"));
  await fs.writeFile(path.join(root, "package", "package.json"),
    `${JSON.stringify({ name: "@inthedark/wb", version, private: false }, null, 2)}\n`);
}

test("blank release versions increment the committed patch", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-release-version-");
  context.after(() => temporary.dispose());
  await writeManifest(temporary.path, "1.2.3");

  assert.equal(await preparePackageVersion({ root: temporary.path }), "1.2.4");
  const manifest = JSON.parse(await fs.readFile(path.join(temporary.path, "package", "package.json"), "utf8"));
  assert.deepEqual(manifest, { name: "@inthedark/wb", version: "1.2.4", private: false });
});

test("explicit release versions replace the committed version exactly", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-release-override-");
  context.after(() => temporary.dispose());
  await writeManifest(temporary.path, "1.2.3");

  assert.equal(await preparePackageVersion({ root: temporary.path, requestedVersion: "2.0.0" }), "2.0.0");
  const filename = path.join(temporary.path, "package", "package.json");
  const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.deepEqual(manifest, { name: "@inthedark/wb", version: "2.0.0", private: false });
});

test("invalid release versions fail before rewriting the manifest", async context => {
  const cases = [
    { current: "1.2.3", requestedVersion: "next" },
    { current: "1.2.3", requestedVersion: "1.2.4-beta.1" },
    { current: "1.2.3-beta.1" },
    { current: `1.2.${Number.MAX_SAFE_INTEGER}` },
  ];
  for (const [index, invalid] of cases.entries()) {
    const temporary = await WorkbenchTemporaryDirectory.create(`wb-release-invalid-${index}-`);
    context.after(() => temporary.dispose());
    await writeManifest(temporary.path, invalid.current);
    const filename = path.join(temporary.path, "package", "package.json");
    const before = await fs.readFile(filename, "utf8");

    await assert.rejects(
      preparePackageVersion({ root: temporary.path, requestedVersion: invalid.requestedVersion }),
      /stable major\.minor\.patch|increment/u,
    );
    assert.equal(await fs.readFile(filename, "utf8"), before);
  }
});

test("package publication copies the root README only after the committed version matches", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-publish-package-");
  context.after(() => temporary.dispose());
  await fs.mkdir(path.join(temporary.path, "package"));
  await fs.writeFile(path.join(temporary.path, "README.md"), "# root readme\n");
  await fs.writeFile(path.join(temporary.path, "package", "package.json"), '{"version":"1.2.3"}\n');

  await assert.rejects(
    preparePackagePublication({ root: temporary.path, expectedVersion: "1.2.4" }),
    /contains 1\.2\.3/u,
  );
  await assert.rejects(fs.access(path.join(temporary.path, "package", "README.md")), { code: "ENOENT" });

  await preparePackagePublication({ root: temporary.path, expectedVersion: "1.2.3" });
  assert.equal(await fs.readFile(path.join(temporary.path, "package", "README.md"), "utf8"), "# root readme\n");
});

test("npm runs from the package directory rather than adopting root developer engines", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-publish-command-");
  context.after(() => temporary.dispose());
  const packageDirectory = path.join(temporary.path, "package");
  await fs.mkdir(packageDirectory);
  await fs.writeFile(path.join(temporary.path, "README.md"), "# root readme\n");
  await fs.writeFile(path.join(packageDirectory, "package.json"), '{"version":"1.2.3"}\n');
  const calls: unknown[][] = [];

  await runPackagePublication({
    mode: "publish",
    expectedVersion: "1.2.3",
    root: temporary.path,
    commands: { run: async (...args: unknown[]) => { calls.push(args); } },
  });

  assert.deepEqual(calls, [["npm", ["publish"], { cwd: packageDirectory, interactive: true }]]);
});
