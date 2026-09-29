/* No exports. Protect exact detached-service retirement and parent-owned cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import test from "node:test";
import WorkbenchTestProcessResources from "./WorkbenchTestProcessResources";

test("a retained service record kills its detached process without its spawning worker", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-retirement-");
  const directory = temporary.path;
  const record = path.join(directory, "service.json");
  const child = spawn(process.execPath, ["-e",
    'process.on("message", () => {}); process.send("ready");'], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    assert.ok(child.pid);
    await fs.writeFile(record, JSON.stringify({ pid: child.pid, password: "must-not-be-logged" }));
    await WorkbenchTestProcessResources.retireService(record);
    await exited;
    await assert.rejects(fs.stat(record), { code: "ENOENT" });
    await WorkbenchTestProcessResources.retireService(record);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await temporary.dispose();
  }
});

test("failed retirement preserves the ownership record and never counts as clean", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-retirement-");
  const directory = temporary.path;
  const record = path.join(directory, "service.json");
  try {
    await fs.writeFile(record, JSON.stringify({ pid: 12345 }));
    const killed: number[] = [];
    await assert.rejects(WorkbenchTestProcessResources.retireService(record, async pid => {
      killed.push(pid);
      throw new Error("access denied");
    }), /access denied/u);
    assert.deepEqual(killed, [12345]);
    assert.ok(await fs.stat(record));
  } finally { await temporary.dispose(); }
});

test("parent cleanup removes only registered project-owned scenario roots", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-scenario-retirement-");
  context.after(async () => await temporary.dispose());
  const source = temporary.path;
  const fixtures = path.join(source, ".workbench", "test-runs");
  const owned = path.join(fixtures, "wb-scenario-owned");
  const unrelated = path.join(fixtures, "other");
  await fs.mkdir(owned, { recursive: true });
  await fs.mkdir(unrelated);
  const resources = await WorkbenchTestProcessResources.create(false, source);
  const previous = process.env.WORKBENCH_TEST_SERVICE_RECORDS;
  process.env.WORKBENCH_TEST_SERVICE_RECORDS = resources.file;
  context.after(() => {
    if (previous === undefined) delete process.env.WORKBENCH_TEST_SERVICE_RECORDS;
    else process.env.WORKBENCH_TEST_SERVICE_RECORDS = previous;
  });
  await assert.rejects(
    WorkbenchTestProcessResources.trackWorkspace(source, unrelated),
    /scenario workspace/u,
  );
  await WorkbenchTestProcessResources.trackWorkspace(source, owned);
  await resources.dispose();
  await assert.rejects(fs.stat(owned), { code: "ENOENT" });
  assert.ok(await fs.stat(unrelated));
});
