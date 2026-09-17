/*
 * No production exports. Node tests protect exclusive app-process acquisition and OS-backed release without timer races.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchAppLaunchLease from "./WorkbenchAppLaunchLease.ts";

test("allows one app lease and releases it for the next process owner", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-lease-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const databasePath = path.join(root, "runtime", "app.sqlite3");

  const first = await WorkbenchAppLaunchLease.acquire({ databasePath });
  assert.ok(first);
  assert.equal(await WorkbenchAppLaunchLease.acquire({ databasePath }), null);

  await first.dispose();
  const next = await WorkbenchAppLaunchLease.acquire({ databasePath });
  assert.ok(next);
  await next.dispose();
});

test("one data root admits only one app launch", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-installation-leases-"));
  const dataRootPath = path.join(root, "data");
  const options = { dataRootPath };
  let first: Awaited<ReturnType<typeof WorkbenchAppLaunchLease.acquire>> = null;
  let second: Awaited<ReturnType<typeof WorkbenchAppLaunchLease.acquire>> = null;
  context.after(async () => {
    await second?.dispose();
    await first?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  first = await WorkbenchAppLaunchLease.acquire(options);
  assert.ok(first);
  second = await WorkbenchAppLaunchLease.acquire(options);
  assert.equal(second, null);
});
