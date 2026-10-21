/*
 * No exports. Busy lease tests protect reason union, release-on-idle and dead-process filtering.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchBusyLease, { readWorkbenchBusyLeases } from "./WorkbenchBusyLease.mjs";
import WorkbenchTemporaryDirectory from "./WorkbenchTemporaryDirectory.ts";

async function dataRoot(context: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-busy-lease-");
  context.after(() => temporary.dispose());
  return temporary.path;
}

const reasons = async (root: string, alive = (_pid: number) => true) =>
  (await readWorkbenchBusyLeases(root, { alive })).map(lease => `${lease.holder}:${lease.reasons.join("+")}`);

test("a process publishes every held reason and drops its lease once it holds none", async (context) => {
  const root = await dataRoot(context);
  const lease = new WorkbenchBusyLease({ dataRoot: root, holder: "daemon", pid: 41, alive: () => true });
  lease.hold("threads", "2 threads working");
  lease.hold("reloading", "reloading");
  assert.deepEqual(await reasons(root), ["daemon:2 threads working+reloading"]);
  lease.hold("threads", null);
  assert.deepEqual(await reasons(root), ["daemon:reloading"]);
  lease.hold("reloading", null);
  assert.deepEqual(await reasons(root), []);
});

test("close releases every reason", async (context) => {
  const root = await dataRoot(context);
  const lease = new WorkbenchBusyLease({ dataRoot: root, holder: "app", pid: 42, alive: () => true });
  lease.hold("update", "update pulling");
  lease.close();
  assert.deepEqual(await reasons(root), []);
});

test("leases of dead processes are ignored, and the holder's next process sweeps them", async (context) => {
  const root = await dataRoot(context);
  const crashed = new WorkbenchBusyLease({ dataRoot: root, holder: "daemon", pid: 7, alive: () => true });
  crashed.hold("threads", "1 thread working");
  const alive = (pid: number) => pid !== 7;
  assert.deepEqual(await reasons(root, alive), []);
  const next = new WorkbenchBusyLease({ dataRoot: root, holder: "daemon", pid: 8, alive });
  next.hold("reloading", "reloading");
  assert.deepEqual(await fs.readdir(path.join(root, "busy")), ["daemon-8.json"]);
});

test("a live process's unreadable lease still reads as busy", async (context) => {
  const root = await dataRoot(context);
  await fs.mkdir(path.join(root, "busy"));
  await fs.writeFile(path.join(root, "busy", "repair-9.json"), "{");
  assert.deepEqual(await reasons(root), ["repair:unreadable busy lease"]);
});
