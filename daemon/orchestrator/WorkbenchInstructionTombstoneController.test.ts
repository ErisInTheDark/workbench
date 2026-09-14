/*
 * No production exports. Tests protect one-time instruction retirement and crash recovery.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { insertRow, selectRows } from "workbench-shared/database/workbench-database-statements";

import { instructionTombstoneTables } from "../lib/workbench/database/schema/instruction-tombstone-schema";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchInstructionTombstoneController from "./WorkbenchInstructionTombstoneController";

const marker = {
  markerRelativePath: "wb/mechanics/thread-state.md.tombstone",
  targetRelativePath: "wb/mechanics/thread-state.md",
} as const;

async function exists(filePath: string) {
  return await access(filePath).then(() => true, () => false);
}

test("a consumed instruction tombstone never deletes a later user recreation", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-consume-"));
  const libraryRoot = path.join(rootPath, "library");
  const database = new WorkbenchDatabaseController({ databasePath: path.join(rootPath, "workbench.sqlite3") });
  const targetPath = path.join(libraryRoot, "wb", "mechanics", "thread-state.md");
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "retired Workbench instructions\n", "utf8");
    await database.start();
    const controller = new WorkbenchInstructionTombstoneController({
      createReceiptId: () => "first-receipt",
      database,
      libraryRoot,
      now: () => 100,
    });

    await controller.consume([marker]);
    assert.equal(await exists(targetPath), false);
    assert.deepEqual(
      await database.query(selectRows(instructionTombstoneTables.instructionTombstones)),
      [{
        consumed_at: 100,
        first_observed_at: 100,
        quarantine_path: "wb/mechanics/.thread-state.workbench-tombstone-first-receipt",
        state: "consumed",
        target_path: marker.targetRelativePath,
      }],
    );

    await writeFile(targetPath, "user recreation\n", "utf8");
    await controller.consume([marker]);
    assert.equal(await readFile(targetPath, "utf8"), "user recreation\n");
  } finally {
    await database.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("an absent retired file is consumed before a future user creation", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-absent-"));
  const libraryRoot = path.join(rootPath, "library");
  const database = new WorkbenchDatabaseController({ databasePath: path.join(rootPath, "workbench.sqlite3") });
  const targetPath = path.join(libraryRoot, "wb", "mechanics", "thread-state.md");
  try {
    await database.start();
    const controller = new WorkbenchInstructionTombstoneController({
      createReceiptId: () => "absent-receipt",
      database,
      libraryRoot,
      now: () => 100,
    });

    await controller.consume([marker]);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "future user instructions\n", "utf8");
    await controller.consume([marker]);

    assert.equal(await readFile(targetPath, "utf8"), "future user instructions\n");
  } finally {
    await database.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("pending quarantine recovery removes only the retired file", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-recovery-"));
  const libraryRoot = path.join(rootPath, "library");
  const database = new WorkbenchDatabaseController({ databasePath: path.join(rootPath, "workbench.sqlite3") });
  const targetPath = path.join(libraryRoot, "wb", "mechanics", "thread-state.md");
  const quarantineRelativePath = "wb/mechanics/.thread-state.workbench-tombstone-recovery";
  const quarantinePath = path.join(libraryRoot, ...quarantineRelativePath.split("/"));
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(quarantinePath, "retired Workbench instructions\n", "utf8");
    await writeFile(targetPath, "user recreation\n", "utf8");
    await database.start();
    await database.executeTransaction([insertRow(instructionTombstoneTables.instructionTombstones, {
      consumed_at: null,
      first_observed_at: 50,
      quarantine_path: quarantineRelativePath,
      state: "pending",
      target_path: marker.targetRelativePath,
    })]);
    const controller = new WorkbenchInstructionTombstoneController({
      createReceiptId: () => "unused",
      database,
      libraryRoot,
      now: () => 100,
    });

    await controller.consume([marker]);

    assert.equal(await readFile(targetPath, "utf8"), "user recreation\n");
    assert.equal(await exists(quarantinePath), false);
    assert.equal(
      (await database.query(selectRows(instructionTombstoneTables.instructionTombstones)))[0]?.state,
      "consumed",
    );
  } finally {
    await database.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});
