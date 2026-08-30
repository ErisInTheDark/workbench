/* No production exports. Real SQLite wards protect app registration identity and relational validity. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import Database from "better-sqlite3";
import { insertRow } from "workbench-shared/database/workbench-database-statements";
import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { appStateSchema, appStateTables } from "workbench-shared/state/workbench-app-state-schema";

async function temporaryDatabase(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  return path.join(directory, "state.sqlite3");
}

test("the local daemon registration remains stable across app restarts", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const first = new WorkbenchAppStateRepository({ databasePath, now: () => 10 });
  const firstId = first.start();
  first.close();

  const second = new WorkbenchAppStateRepository({ databasePath, now: () => 20 });
  const secondId = second.start();
  second.close();

  assert.equal(secondId, firstId);
});

test("daemon-scoped state rejects an unknown app registration", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const repository = new WorkbenchAppStateRepository({ databasePath });
  repository.start();
  assert.throws(() => repository.executeTransaction([
    insertRow(appStateTables.projectExpandedDirectories, {
      daemon_registration_id: "missing",
      deleted: 0,
      path: "src",
      project_id: "project",
      revision: 1,
    }),
  ]), /FOREIGN KEY constraint failed/u);
  repository.close();
});

test("checked scalar families reject value columns that do not match their key", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const database = new Database(databasePath);
  applyWorkbenchDatabaseSchema(database, appStateSchema);
  assert.throws(() => database.prepare(`
    INSERT INTO global_preferences(
      key, boolean_value, integer_value, text_value, deleted, revision
    ) VALUES ('theme', 1, NULL, NULL, 0, 1)
  `).run(), /CHECK constraint failed/u);
  database.close();
});
