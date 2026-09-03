/*
 * Keywords: tests, concurrency, SQLite, temp, lifecycle.
 * No exports. Tests protect cross-process test-run serialization and stale temp-root cleanup without timer races.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ProjectTestRunCoordinator from "./ProjectTestRunCoordinator";

test("waits for the active lease before resetting and acquiring the shared test temp root", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-test-coordinator-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const databasePath = path.join(root, "runtime", "lock.sqlite3");
  const temporaryRootPath = path.join(root, "tmp", "tests");
  const first = new ProjectTestRunCoordinator({ databasePath, temporaryRootPath });
  const firstLease = await first.acquire();
  const markerPath = path.join(temporaryRootPath, "first-owner");
  await fs.writeFile(markerPath, "owned");

  let reportWait!: () => void;
  const waiting = new Promise<void>((resolve) => { reportWait = resolve; });
  let retry!: () => void;
  const retryGate = new Promise<void>((resolve) => { retry = resolve; });
  const second = new ProjectTestRunCoordinator({
    databasePath,
    onWait: reportWait,
    temporaryRootPath,
    waitForRetry: async () => await retryGate,
  });
  const secondLeasePromise = second.acquire();
  await waiting;
  assert.equal(await fs.readFile(markerPath, "utf8"), "owned");

  await firstLease.dispose();
  retry();
  const secondLease = await secondLeasePromise;
  await assert.rejects(fs.stat(markerPath), { code: "ENOENT" });
  assert.equal((await fs.stat(temporaryRootPath)).isDirectory(), true);
  await secondLease.dispose();
  await assert.rejects(fs.stat(temporaryRootPath), { code: "ENOENT" });
});
