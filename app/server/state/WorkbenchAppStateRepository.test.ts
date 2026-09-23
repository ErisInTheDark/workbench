/* No exports. Tests protect app-state persistence and migration backup lifecycle. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureTestOutput } from "../../../test/capture-test-output.mts";

import Database from "better-sqlite3";
import { DATABASE_LOG_PREFIX } from "workbench-shared/database/database-log-format";
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
  captureTestOutput(context, process.stdout, text =>
    text.startsWith(DATABASE_LOG_PREFIX) || text.startsWith("[database] restored schema "));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  return path.join(directory, "state.sqlite3");
}

test("code-detail preferences survive reopening and retain pre-upgrade settings", async context => {
  const databasePath = await temporaryDatabase(context);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 13 });
  old.prepare("INSERT INTO global_preferences(key,text_value,deleted,revision) VALUES ('theme','winter',0,1)").run();
  old.prepare("INSERT INTO daemon_registrations(id,kind,created_at,revision) VALUES ('retained','local',0,1)").run();
  old.prepare("INSERT INTO project_preferences(daemon_registration_id,project_id,key,enabled,boolean_value,deleted,revision) VALUES ('retained','alpha','threadCodeBlockWrap',1,1,0,2)").run();
  old.close();
  const repository = new WorkbenchAppStateRepository({ databasePath });
  const daemon = await repository.start();
  try {
    repository.commit(revision => [
      insertRow(appStateTables.globalPreferences, {
        key: "threadCodeDetails", boolean_value: 1, integer_value: null, text_value: null, deleted: 0, revision,
      }),
      insertRow(appStateTables.projectPreferences, {
        key: "threadCodeDetails", boolean_value: 0, integer_value: null, text_value: null, deleted: 0, revision,
        enabled: 1, daemon_registration_id: daemon, project_id: "alpha",
      }),
    ]);
  } finally { await repository.close(); }
  const reopened = new WorkbenchAppStateRepository({ databasePath });
  await reopened.start();
  try {
    assert.equal(reopened.query(selectRows(appStateTables.globalPreferences, { where: { key: "theme" } }))[0]?.text_value, "winter");
    assert.equal(reopened.query(selectRows(appStateTables.globalPreferences, { where: { key: "threadCodeDetails" } }))[0]?.boolean_value, 1);
    const project = reopened.query(selectRows(appStateTables.projectPreferences, { where: { key: "threadCodeDetails" } }))[0];
    assert.equal(project?.boolean_value, 0);
    assert.equal(project?.enabled, 1);
    assert.equal(project?.project_id, "alpha");
    const retained = reopened.query(selectRows(appStateTables.projectPreferences, { where: { key: "threadCodeBlockWrap" } }))[0];
    assert.equal(retained?.boolean_value, 1);
    assert.equal(retained?.enabled, 1);
    assert.equal(retained?.daemon_registration_id, "retained");
  } finally { await reopened.close(); }
});

test("favourite provider references retain standalone favourites across the upgrade", async context => {
  const databasePath = await temporaryDatabase(context);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 7 });
  old.prepare("INSERT INTO model_preferences(harness, model_id, favourite, deleted, revision) VALUES ('copilot', 'retained', 1, 0, 8)").run();
  const before = old.prepare("SELECT * FROM model_preferences").all();
  old.close();
  const repository = new WorkbenchAppStateRepository({ databasePath });
  try {
    await repository.start();
    assert.deepEqual(repository.query(selectRows(appStateTables.modelPreferences)), before);
    assert.throws(() => repository.executeTransaction([
      insertRow(appStateTables.modelPreferences, { harness: "codex", model_id: "unadmitted", favourite: 1, deleted: 0, revision: 9 }),
    ]), /FOREIGN KEY/);
    const stored = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(stored.prepare("SELECT id FROM workbench_harnesses").all(), [{ id: "copilot" }]);
      assert.deepEqual(stored.pragma("foreign_key_check"), []);
    } finally { stored.close(); }
  } finally { await repository.close(); }
});

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

for (const rejectCheckpoint of [false, true]) {
  test(`app startup recovers a newer database before serving (reject checkpoint: ${rejectCheckpoint})`, async context => {
    const databasePath = await temporaryDatabase(context);
    const repository = new WorkbenchAppStateRepository({ databasePath });
    const registration = await repository.start();
    await repository.close();
    const candidate = new Database(databasePath);
    const backups = path.join(path.dirname(databasePath), "backups", path.basename(databasePath));
    try {
      candidate.exec("CREATE TABLE recovery_evidence(value TEXT); INSERT INTO recovery_evidence VALUES ('original')");
      await preserveWorkbenchDatabaseBackup(candidate, backups);
      candidate.exec("UPDATE recovery_evidence SET value = 'failed-upgrade'");
      candidate.pragma(`user_version = ${appStateSchema.currentVersion + 1}`);
    } finally { candidate.close(); }
    let archive = "";
    const diagnostics: string[] = [];
    repository.configureDiagnostics((level, message) => {
      if (level === "info") diagnostics.push(message);
    });
    try {
      const opening = repository.start(archivePath => {
        archive = archivePath;
        if (rejectCheckpoint) throw new Error("recovery checkpoint rejected");
      });
      if (rejectCheckpoint) await assert.rejects(opening, /recovery checkpoint rejected/);
      else assert.equal(await opening, registration);
      assert.ok(diagnostics.some(message => message.includes("backup")));
      if (!rejectCheckpoint) assert.ok(diagnostics.some(message => message.includes("restored schema")));
      assert.equal(path.dirname(archive), path.join(backups, "failed-upgrades"));
      const inspection = new Database(databasePath, { readonly: true });
      const archived = new Database(archive, { readonly: true });
      try {
        assert.deepEqual(inspection.prepare("SELECT value FROM recovery_evidence").get(), {
          value: rejectCheckpoint ? "failed-upgrade" : "original",
        });
        assert.deepEqual(archived.prepare("SELECT value FROM recovery_evidence").get(), { value: "failed-upgrade" });
      } finally { inspection.close(); archived.close(); }
    } finally { await repository.close(); }
  });
}

test("repositories sharing one data root reopen the same app state", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-installation-state-"));
  const dataRootPath = path.join(directory, "data");
  const first = new WorkbenchAppStateRepository({ dataRootPath });
  let second: WorkbenchAppStateRepository | null = null;
  try {
    const firstId = await first.start();
    first.executeTransaction([insertRow(appStateTables.globalPreferences, {
      key: "theme", text_value: "dark", deleted: 0, revision: 1,
    })]);
    await first.close();
    second = new WorkbenchAppStateRepository({ dataRootPath });
    assert.equal(await second.start(), firstId);
    assert.equal(second.query(selectRows(appStateTables.globalPreferences))[0]?.text_value, "dark");
  } finally {
    await Promise.all([first.close(), second?.close()]);
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
