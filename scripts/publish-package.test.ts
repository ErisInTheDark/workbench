/*
 * No production exports. Protects release version confirmation and generated package README content.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { preparePackagePublication, runPackagePublication } from "./publish-package.mjs";

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
