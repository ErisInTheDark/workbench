/*
 * No production exports. Node tests protect project-local Workbench temporary-directory ownership and exact-child cleanup. Keywords: temp, project, cleanup, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import WorkbenchTemporaryDirectory from "./WorkbenchTemporaryDirectory";

test("creates and disposes only its child inside this project's temporary root", async () => {
  const directory = await WorkbenchTemporaryDirectory.create("workbench-temp-owner-test-");
  const siblingPath = path.join(path.dirname(directory.path), "temporary-owner-sibling");
  await fs.mkdir(siblingPath, { recursive: true });
  try {
    assert.equal(
      path.relative(WorkbenchTemporaryDirectory.projectRootPath, directory.path).startsWith(".."),
      false,
    );
    assert.equal(
      path.relative(WorkbenchTemporaryDirectory.rootPath, directory.path).startsWith(".."),
      false,
    );
    await directory.dispose();
    await assert.rejects(fs.stat(directory.path), { code: "ENOENT" });
    assert.equal((await fs.stat(siblingPath)).isDirectory(), true);
  } finally {
    await fs.rm(siblingPath, { force: true, recursive: true });
    await directory.dispose();
  }
});
