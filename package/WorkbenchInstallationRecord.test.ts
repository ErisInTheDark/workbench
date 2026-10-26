/*
 * No production exports. Tests that the installation lock excludes concurrent record owners.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import WorkbenchInstallationRecord from "./WorkbenchInstallationRecord.mjs";

test("a second lock holder is refused while the first holds the installation", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-installation-record-");
  context.after(() => temporary.dispose());
  const record = new WorkbenchInstallationRecord({ dataRoot: temporary.path });
  const held = await record.lock();
  try {
    await assert.rejects(new WorkbenchInstallationRecord({ dataRoot: temporary.path }).lock(), /Another Workbench installation is running/u);
  } finally {
    held.close();
  }
  (await record.lock()).close();
  await assert.rejects(fs.access(record.path), { code: "ENOENT" });
});
