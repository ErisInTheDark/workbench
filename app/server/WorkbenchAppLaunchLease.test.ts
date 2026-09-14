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

test("installation roots isolate app leases without changing within-installation exclusion", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-installation-leases-"));
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const firstOptions = { repositoryRootPath: firstRoot, workbenchLibraryRoot: path.join(root, "legacy-library") };
  const secondOptions = { ...firstOptions, repositoryRootPath: secondRoot };
  let first: Awaited<ReturnType<typeof WorkbenchAppLaunchLease.acquire>> = null;
  let second: Awaited<ReturnType<typeof WorkbenchAppLaunchLease.acquire>> = null;
  context.after(async () => {
    await second?.dispose();
    await first?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  first = await WorkbenchAppLaunchLease.acquire(firstOptions);
  assert.ok(first);
  second = await WorkbenchAppLaunchLease.acquire(secondOptions);
  assert.ok(second);
  assert.equal(await WorkbenchAppLaunchLease.acquire(firstOptions), null);
});
