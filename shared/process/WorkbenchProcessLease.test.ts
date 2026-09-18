/*
 * No production exports. Protect exclusive process acquisition and independent owner leases without timer races.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchProcessLease from "./WorkbenchProcessLease.ts";

test("allows one app lease and releases it for the next process owner", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-lease-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const databasePath = path.join(root, "runtime", "app.sqlite3");

  const first = await WorkbenchProcessLease.acquire(databasePath);
  assert.ok(first);
  assert.equal(await WorkbenchProcessLease.acquire(databasePath), null);

  await first.dispose();
  const next = await WorkbenchProcessLease.acquire(databasePath);
  assert.ok(next);
  await next.dispose();
});

test("independent process owners do not contend on each other's leases", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-installation-leases-"));
  let first: Awaited<ReturnType<typeof WorkbenchProcessLease.acquire>> = null;
  let second: Awaited<ReturnType<typeof WorkbenchProcessLease.acquire>> = null;
  context.after(async () => {
    await second?.dispose();
    await first?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  first = await WorkbenchProcessLease.acquire(path.join(root, "app.sqlite3"));
  assert.ok(first);
  second = await WorkbenchProcessLease.acquire(path.join(root, "daemon.sqlite3"));
  assert.ok(second);
});
