/*
 * No production exports. Tests protect mandatory node readiness, transcript registration, and worker closure. Keywords: database, graph, lifecycle, test.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import WorkbenchDatabaseNode from "./WorkbenchDatabaseNode";

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("the database node proves readiness before exposing transcript work and closes its worker on disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-"));
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
  const database = instance.registrations.database!;
  const transcript = instance.registrations.transcript!;
  try {
    await instance.start();
    database.assertReady();
    assert.equal(transcript.failure, null);

    await instance.dispose();
    assert.equal(database.state, "closed");
    await assert.rejects(database.start(), /closed/);
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the replacement database node consumes one reset request before opening SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-reset-"));
  const storage = join(directory, ".workbench");
  const databasePath = join(storage, "workbench.sqlite3");
  const resetRequestPath = join(storage, "reset-workbench-sqlite");
  await mkdir(storage);
  await writeFile(databasePath, "invalid old database", "utf8");
  await writeFile(`${databasePath}-wal`, "old wal", "utf8");
  await writeFile(`${databasePath}-shm`, "old shm", "utf8");
  await writeFile(resetRequestPath, "workbench-sqlite-shadow-reset-v1\n", "utf8");
  const preserved = join(storage, "transcripts.json");
  await writeFile(preserved, "keep", "utf8");
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => true,
      lease: { isCurrent: () => true },
      mode: "replacement",
    },
  );
  try {
    await instance.start();
    instance.registrations.database!.assertReady();
    assert.equal(await exists(resetRequestPath), false);
    assert.equal(await readFile(preserved, "utf8"), "keep");
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed database deletion leaves the reset request for a later retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-node-reset-failure-"));
  const storage = join(directory, ".workbench");
  const databasePath = join(storage, "workbench.sqlite3");
  const resetRequestPath = join(storage, "reset-workbench-sqlite");
  await mkdir(storage);
  await mkdir(databasePath);
  await writeFile(resetRequestPath, "workbench-sqlite-shadow-reset-v1\n", "utf8");
  const instance = WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as OrchestratorProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      handoffState: undefined,
      isReplacing: () => true,
      lease: { isCurrent: () => true },
      mode: "replacement",
    },
  );
  try {
    await assert.rejects(async () => await instance.start(), /workbench\.sqlite3/u);
    assert.equal(await readFile(resetRequestPath, "utf8"), "workbench-sqlite-shadow-reset-v1\n");
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
