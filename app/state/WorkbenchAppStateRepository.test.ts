/* No exports. Tests protect app-state persistence and migration backup lifecycle. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import Database from "better-sqlite3";
import {
  insertRow,
  selectRows,
  updateRows,
} from "workbench-shared/database/workbench-database-statements";
import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { appStateSchema, appStateTables } from "workbench-shared/state/workbench-app-state-schema";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";

async function temporaryDatabase(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-"));
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  return path.join(directory, "state.sqlite3");
}

test("model preferences upgrade v6 without losing existing preferences or the backup", async context => {
  const databasePath = await temporaryDatabase(context);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 6 });
  old.prepare("INSERT INTO global_preferences(key,text_value,deleted,revision) VALUES ('theme','winter',0,1)").run();
  old.close();
  const repository = new WorkbenchAppStateRepository({ databasePath });
  try {
    await repository.start();
    assert.deepEqual(repository.query(selectRows(appStateTables.modelPreferences)), []);
    assert.equal(repository.query(selectRows(appStateTables.globalPreferences))[0]?.text_value, "winter");
    const backups = path.join(path.dirname(databasePath), "backups", path.basename(databasePath));
    const files = await fs.readdir(backups);
    assert.equal(files.length, 1);
    const backup = new Database(path.join(backups, files[0]!), { readonly: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), 6);
      assert.deepEqual(backup.prepare("SELECT text_value FROM global_preferences WHERE key='theme'").get(), { text_value: "winter" });
    } finally { backup.close(); }
  } finally { await repository.close(); }
});

test("app startup preserves its pre-upgrade database even when closed during opening", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 1 });
  old.prepare("INSERT INTO global_preferences(key,text_value,deleted,revision) VALUES ('theme','retained',0,1)").run();
  old.close();
  const repository = new WorkbenchAppStateRepository({ databasePath });
  try {
    const started = repository.start();
    const closed = repository.close();
    await started;
    await closed;
    const directory = path.join(path.dirname(databasePath), "backups", path.basename(databasePath));
    const files = await fs.readdir(directory).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(files.length, 1, "startup must preserve one pre-upgrade backup");
    const backup = new Database(path.join(directory, files[0]!), { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), 1);
      assert.deepEqual(backup.prepare("SELECT text_value FROM global_preferences WHERE key='theme'").get(), { text_value: "retained" });
    } finally {
      backup.close();
    }
  } finally {
    await repository.close();
  }
});

test("app migration cannot run before the branch retains its rollback checkpoint", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 1 });
  old.close();
  const repository = new WorkbenchAppStateRepository({ databasePath });
  try {
    await assert.rejects(repository.start(() => {
      throw new Error("app checkpoint was not retained");
    }), /app checkpoint was not retained/u);
  } finally {
    await repository.close();
  }
  const inspection = new Database(databasePath, { readonly: true });
  try { assert.equal(inspection.pragma("user_version", { simple: true }), 1); }
  finally { inspection.close(); }
});

test("the retained app repository restores schema, data and registration before a later reload", async context => {
  const databasePath = await temporaryDatabase(context);
  const repository = new WorkbenchAppStateRepository({ databasePath });
  const registration = await repository.start();
  await repository.close();
  const candidate = new Database(databasePath);
  let checkpoint: string;
  try {
    candidate.exec("CREATE TABLE rollback_evidence(legacy TEXT); INSERT INTO rollback_evidence VALUES ('retained')");
    checkpoint = await preserveWorkbenchDatabaseBackup(candidate, path.join(path.dirname(databasePath), "rollback"));
    candidate.exec("DROP TABLE rollback_evidence; CREATE TABLE candidate_only(value TEXT)");
    const version = candidate.pragma("user_version", { simple: true }) as number;
    candidate.pragma(`user_version = ${version + 1}`);
  } finally { candidate.close(); }
  try {
    assert.equal(await repository.resume(checkpoint), registration);
    const inspection = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(inspection.prepare("SELECT legacy FROM rollback_evidence").all(), [{ legacy: "retained" }]);
      assert.equal(inspection.prepare("SELECT name FROM sqlite_schema WHERE name = 'candidate_only'").get(), undefined);
    } finally { inspection.close(); }
    await repository.close();
    assert.equal(await repository.resume(), registration);
  } finally { await repository.close(); }
});

test("the local daemon registration remains stable across app restarts", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const first = new WorkbenchAppStateRepository({ databasePath, now: () => 10 });
  const firstId = await first.start();
  await first.close();

  const second = new WorkbenchAppStateRepository({ databasePath, now: () => 20 });
  const secondId = await second.start();
  await second.close();

  assert.equal(secondId, firstId);
});

test("installation roots keep app state independent and durable", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-installation-state-"));
  const firstOptions = { repositoryRootPath: path.join(directory, "first"), workbenchLibraryRoot: path.join(directory, "legacy-library") };
  const secondOptions = { ...firstOptions, repositoryRootPath: path.join(directory, "second") };
  const first = new WorkbenchAppStateRepository(firstOptions);
  const second = new WorkbenchAppStateRepository(secondOptions);
  const reopened = new WorkbenchAppStateRepository(firstOptions);
  try {
    const firstId = await first.start();
    const secondId = await second.start();
    assert.notEqual(firstId, secondId);
    first.executeTransaction([insertRow(appStateTables.globalPreferences, {
      key: "theme", text_value: "dark", deleted: 0, revision: 1,
    })]);
    assert.deepEqual(second.query(selectRows(appStateTables.globalPreferences)), []);
    await first.close();
    assert.equal(await reopened.start(), firstId);
    assert.equal(reopened.query(selectRows(appStateTables.globalPreferences))[0]?.text_value, "dark");
  } finally {
    await Promise.all([first.close(), second.close(), reopened.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("daemon-scoped state rejects an unknown app registration", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const repository = new WorkbenchAppStateRepository({ databasePath });
  await repository.start();
  assert.throws(() => repository.executeTransaction([
    insertRow(appStateTables.projectExpandedDirectories, {
      daemon_registration_id: "missing",
      deleted: 0,
      path: "src",
      project_id: "project",
      revision: 1,
    }),
  ]), /FOREIGN KEY constraint failed/u);
  await repository.close();
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

test("selected-project pin placement persists as text at global and project scopes", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const repository = new WorkbenchAppStateRepository({ databasePath });
  const daemonRegistrationId = await repository.start();
  assert.throws(() => repository.executeTransaction([
    insertRow(appStateTables.globalPreferences, {
      boolean_value: 1,
      deleted: 0,
      integer_value: null,
      key: "selectedProjectPinPlacement",
      revision: 1,
      text_value: null,
    }),
  ]), /CHECK constraint failed/u);

  repository.commit((revision) => [
    insertRow(appStateTables.globalPreferences, {
      boolean_value: null,
      deleted: 0,
      integer_value: null,
      key: "selectedProjectPinPlacement",
      revision,
      text_value: "threads-section",
    }),
    insertRow(appStateTables.projectPreferences, {
      boolean_value: null,
      daemon_registration_id: daemonRegistrationId,
      deleted: 0,
      enabled: 1,
      integer_value: null,
      key: "selectedProjectPinPlacement",
      project_id: "project",
      revision,
      text_value: "pinned-section",
    }),
  ]);

  assert.equal(repository.query(selectRows(appStateTables.globalPreferences, {
    where: { key: "selectedProjectPinPlacement" },
  }))[0]?.text_value, "threads-section");
  assert.equal(repository.query(selectRows(appStateTables.projectPreferences, {
    where: {
      daemon_registration_id: daemonRegistrationId,
      key: "selectedProjectPinPlacement",
      project_id: "project",
    },
  }))[0]?.text_value, "pinned-section");
  await repository.close();
});

test("backup creates a complete independent app-state database", async (context) => {
  const sourcePath = await temporaryDatabase(context);
  const backupPath = path.join(path.dirname(sourcePath), "backup.sqlite3");
  const source = new WorkbenchAppStateRepository({ databasePath: sourcePath });
  await source.start();
  source.commit((revision) => [
    insertRow(appStateTables.globalPreferences, {
      boolean_value: 1,
      deleted: 0,
      integer_value: null,
      key: "composerSpellCheck",
      revision,
      text_value: null,
    }),
  ]);

  await source.backupTo(backupPath);
  const backup = new WorkbenchAppStateRepository({ databasePath: backupPath });
  await backup.start();
  assert.deepEqual(backup.currentVersion(), source.currentVersion());
  assert.equal(
    backup.query(selectRows(appStateTables.globalPreferences, {
      where: { key: "composerSpellCheck" },
    }))[0]?.boolean_value,
    1,
  );

  source.commit((revision) => [updateRows(
    appStateTables.globalPreferences,
    { boolean_value: 0, revision },
    { key: "composerSpellCheck" },
  )]);
  assert.equal(
    backup.query(selectRows(appStateTables.globalPreferences, {
      where: { key: "composerSpellCheck" },
    }))[0]?.boolean_value,
    1,
  );
  await backup.close();
  await source.close();
});
