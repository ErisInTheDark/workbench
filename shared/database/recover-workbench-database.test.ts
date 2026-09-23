/* No exports. Tests protect downgrade recovery, archive isolation and failure safety. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { DATABASE_LOG_PREFIX } from "./database-log-format.ts";
import { captureTestOutput } from "../../test/capture-test-output.mts";
import { defineTable, integer, text } from "./schema/schema-definition.ts";
import {
  applyWorkbenchDatabaseSchema, createTable, defineSubsystemHistory, defineTableHistory,
  defineWorkbenchDatabaseSchema, rebuildTable, tableVersion,
} from "./schema/schema-history.ts";
import migrateWorkbenchDatabase, { preserveWorkbenchDatabaseBackup } from "./workbench-database-migration.ts";
import recoverWorkbenchDatabase from "./recover-workbench-database.ts";

const oldTable = defineTable("records", { id: integer().primaryKey(), legacy: text().notNull() });
const newTable = defineTable("records", { id: integer().primaryKey(), value: text() });
const first = tableVersion({ schemaVersion: 1, table: oldTable, migration: createTable(oldTable) });
const oldSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([defineTableHistory({ current: oldTable, versions: [first] })])],
});
const newSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([defineTableHistory({
    current: newTable,
    versions: [first, tableVersion({ schemaVersion: 2, table: newTable, migration: rebuildTable({ from: oldTable, to: newTable }) })],
  })])],
});

async function fixture(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-recovery-"));
  captureTestOutput(context, process.stdout, text => text.startsWith(DATABASE_LOG_PREFIX)
    || (text.startsWith("[database]") && text.includes(directory)));
  const databasePath = path.join(directory, "state.sqlite3");
  const backups = path.join(directory, "backups", "state.sqlite3");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  applyWorkbenchDatabaseSchema(database, oldSchema);
  database.exec("INSERT INTO records VALUES (1, 'original')");
  context.after(async () => {
    if (database.open) database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { database, databasePath, backups };
}

function read(file: string, sql: string) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try { return database.prepare(sql).all(); }
  finally { database.close(); }
}

test("revert restores old-only data and archives committed newer WAL writes before acknowledgement", async context => {
  const { database, databasePath, backups } = await fixture(context);
  const diagnostics: string[] = [];
  const diagnostic = (level: "info" | "warn", message: string) => {
    if (level === "info") diagnostics.push(message);
  };
  await migrateWorkbenchDatabase(database, newSchema);
  let archive = "";
  // Keep WAL frames present without another writer. Recovery must snapshot them.
  const walReader = new Database(databasePath, { readonly: true });
  walReader.exec("BEGIN");
  walReader.prepare("SELECT * FROM records").all();
  database.exec("UPDATE records SET value = 'failed-upgrade-write'");
  database.close();
  try {
    assert.ok((await fs.stat(`${databasePath}-wal`)).size > 0);
    await recoverWorkbenchDatabase(databasePath, oldSchema, archivePath => {
      archive = archivePath;
      assert.deepEqual(read(archive, "SELECT value FROM records"), [{ value: "failed-upgrade-write" }]);
      assert.deepEqual(read(databasePath, "SELECT value FROM records"), [{ value: "failed-upgrade-write" }]);
      walReader.close();
    }, diagnostic);
  } finally { if (walReader.open) walReader.close(); }
  assert.equal(path.dirname(archive), path.join(backups, "failed-upgrades"));
  assert.deepEqual(read(databasePath, "SELECT legacy FROM records"), [{ legacy: "original" }]);
  assert.deepEqual(read(archive, "PRAGMA user_version"), [{ user_version: 2 }]);
  assert.ok(diagnostics.some(message => message.includes("verify")));
  assert.ok(diagnostics.some(message => message.includes("backup")));
  assert.ok(diagnostics.some(message => message.includes("restored schema")));
  const reported = diagnostics.length;
  await recoverWorkbenchDatabase(databasePath, oldSchema, undefined, diagnostic);
  assert.equal(diagnostics.length, reported);
  assert.equal((await fs.readdir(path.join(backups, "failed-upgrades"))).filter(name => name.endsWith(".sqlite3")).length, 1);
});

test("retry and revert select the newest matching ordinary backup, never the failed archive", async context => {
  const { database, databasePath, backups } = await fixture(context);
  await migrateWorkbenchDatabase(database, newSchema);
  database.close();
  await recoverWorkbenchDatabase(databasePath, oldSchema);
  const retry = new Database(databasePath);
  try {
    retry.exec("UPDATE records SET legacy = 'second-attempt'");
    // Establish distinct ordering without sleeps or a wall-clock race.
    for (const name of await fs.readdir(backups)) {
      if (name.endsWith(".sqlite3")) await fs.utimes(path.join(backups, name), new Date(0), new Date(0));
    }
    await migrateWorkbenchDatabase(retry, newSchema);
    retry.exec("UPDATE records SET value = 'second-failure'");
  } finally { retry.close(); }
  await recoverWorkbenchDatabase(databasePath, oldSchema);
  assert.deepEqual(read(databasePath, "SELECT legacy FROM records"), [{ legacy: "second-attempt" }]);
  assert.equal((await fs.readdir(path.join(backups, "failed-upgrades"))).filter(name => name.endsWith(".sqlite3")).length, 2);
});

test("missing matching backup refuses recovery without altering the newer database", async context => {
  const { database, databasePath, backups } = await fixture(context);
  await preserveWorkbenchDatabaseBackup(database, path.join(backups, "failed-upgrades"));
  applyWorkbenchDatabaseSchema(database, newSchema);
  await preserveWorkbenchDatabaseBackup(database, backups);
  database.close();
  await assert.rejects(recoverWorkbenchDatabase(databasePath, oldSchema), /matching|checkpoint/i);
  assert.deepEqual(read(databasePath, "PRAGMA user_version"), [{ user_version: 2 }]);
});

test("a corrupt newest checkpoint fails closed rather than silently restoring older data", async context => {
  const { database, databasePath, backups } = await fixture(context);
  const older = await preserveWorkbenchDatabaseBackup(database, backups);
  await fs.utimes(older, new Date(0), new Date(0));
  await migrateWorkbenchDatabase(database, newSchema);
  database.close();
  const checkpoint = (await fs.readdir(backups)).find(name => name.endsWith(".sqlite3") && path.join(backups, name) !== older)!;
  await fs.writeFile(path.join(backups, checkpoint), "broken sqlite");
  await assert.rejects(recoverWorkbenchDatabase(databasePath, oldSchema), /backup|checkpoint/i);
  assert.deepEqual(read(databasePath, "PRAGMA user_version"), [{ user_version: 2 }]);
});

test("archive failure prevents replacement", async context => {
  const { database, databasePath, backups } = await fixture(context);
  await migrateWorkbenchDatabase(database, newSchema);
  database.close();
  await fs.writeFile(path.join(backups, "failed-upgrades"), "blocked");
  await assert.rejects(recoverWorkbenchDatabase(databasePath, oldSchema), /backup|archive/i);
  assert.deepEqual(read(databasePath, "PRAGMA user_version"), [{ user_version: 2 }]);
});

test("rejected checkpoint acknowledgement preserves the active newer database and retry remains possible", async context => {
  const { database, databasePath, backups } = await fixture(context);
  await migrateWorkbenchDatabase(database, newSchema);
  database.close();
  await assert.rejects(recoverWorkbenchDatabase(databasePath, oldSchema, () => {
    throw new Error("checkpoint rejected");
  }), /checkpoint rejected/);
  assert.deepEqual(read(databasePath, "PRAGMA user_version"), [{ user_version: 2 }]);
  assert.equal((await fs.readdir(path.join(backups, "failed-upgrades"))).filter(name => name.endsWith(".sqlite3")).length, 1);
  await recoverWorkbenchDatabase(databasePath, oldSchema);
  assert.deepEqual(read(databasePath, "SELECT legacy FROM records"), [{ legacy: "original" }]);
});

test("supported and absent databases do not inspect backups or create archives", async context => {
  const { database, databasePath, backups } = await fixture(context);
  database.close();
  await fs.writeFile(path.dirname(backups), "not a backup directory");
  await recoverWorkbenchDatabase(databasePath, oldSchema);
  assert.deepEqual(read(databasePath, "SELECT legacy FROM records"), [{ legacy: "original" }]);
  const missing = path.join(path.dirname(databasePath), "missing.sqlite3");
  await recoverWorkbenchDatabase(missing, oldSchema);
  await assert.rejects(fs.stat(missing), { code: "ENOENT" });
});
