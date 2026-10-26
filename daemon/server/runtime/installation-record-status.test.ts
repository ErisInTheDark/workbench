/*
 * No production exports. Tests installation record classification against the running checkout and its repair.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { InstallationRecordStatus } from "workbench-shared/workbench/installation-record";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchInstallationRecord from "../../../package/WorkbenchInstallationRecord.mjs";
import { adoptInstallationRecord, readInstallationRecordStatus } from "./installation-record-status";

async function fixture(context: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-installation-status-");
  context.after(() => temporary.dispose());
  const checkoutRoot = path.join(temporary.path, "Checkout");
  const options = { checkoutRoot, dataRoot: path.join(temporary.path, "data") };
  return { options, checkoutRoot, record: new WorkbenchInstallationRecord({ dataRoot: options.dataRoot }) };
}

test("every record state is classified and repaired to the running checkout", async context => {
  const f = await fixture(context);
  const cases: [string, () => Promise<void>, InstallationRecordStatus["record"] | "invalid"][] = [
    ["missing", async () => {}, { state: "missing" }],
    ["unfinished elsewhere", () => f.record.write({ version: 1, root: path.resolve("/elsewhere"), phase: "cloning" }),
      { state: "elsewhere", root: path.resolve("/elsewhere"), phase: "cloning" }],
    ["unfinished here", () => f.record.write({ version: 1, root: f.checkoutRoot, phase: "setup" }),
      { state: "elsewhere", root: f.checkoutRoot, phase: "setup" }],
    ["invalid", async () => {
      await fs.mkdir(path.dirname(f.record.path), { recursive: true });
      await fs.writeFile(f.record.path, "{\"version\":2}");
    }, "invalid"],
  ];
  for (const [label, arrange, expected] of cases) {
    await arrange();
    const before = (await readInstallationRecordStatus(f.options)).record;
    if (expected === "invalid") assert.equal(before.state, "invalid", label);
    else assert.deepEqual(before, expected, label);
    assert.deepEqual((await adoptInstallationRecord(f.options)).record, { state: "current" }, label);
    assert.deepEqual(await f.record.read(), { version: 1, root: f.checkoutRoot, phase: "ready" }, label);
    await fs.rm(f.record.path);
  }
});

test("windows checkout paths match regardless of case", { skip: process.platform !== "win32" }, async context => {
  const f = await fixture(context);
  await f.record.write({ version: 1, root: "C:\\Git\\Workbench", phase: "ready" });
  const status = await readInstallationRecordStatus({ ...f.options, checkoutRoot: "c:\\git\\workbench" });
  assert.deepEqual(status.record, { state: "current" });
});

test("repair is refused while an installer holds the lock", async context => {
  const f = await fixture(context);
  await f.record.write({ version: 1, root: path.resolve("/elsewhere"), phase: "cloning" });
  const held = await f.record.lock();
  try {
    await assert.rejects(adoptInstallationRecord(f.options), /Another Workbench installation is running/u);
  } finally {
    held.close();
  }
  assert.equal((await f.record.read())?.phase, "cloning");
});
