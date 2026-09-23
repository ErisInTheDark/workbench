/*
 * No exports. Tests protect complete migration backups, rollback and retention.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import Database from "better-sqlite3";
import { DATABASE_LOG_PREFIX } from "./database-log-format.ts";
import { defineTable, integer, text } from "./schema/schema-definition.ts";
import {
  applyWorkbenchDatabaseSchema, createTable, defineSubsystemHistory, defineTableHistory,
  defineWorkbenchDatabaseSchema, rebuildTable, tableVersion,
} from "./schema/schema-history.ts";
import migrateWorkbenchDatabase, { preserveWorkbenchDatabaseBackup, restoreWorkbenchDatabaseBackup } from "./workbench-database-migration.ts";

const oldTable = defineTable("records", {
  id: integer().primaryKey(), legacy: text().notNull(), kept: text().notNull(),
});
const newTable = defineTable("records", {
  id: integer().primaryKey(), kept: text().notNull().unique(),
});
const recordsHistory = defineTableHistory({
  current: newTable,
  versions: [
    tableVersion({ schemaVersion: 1, table: oldTable, migration: createTable(oldTable) }),
    tableVersion({ schemaVersion: 2, table: newTable, migration: rebuildTable({ from: oldTable, to: newTable }) }),
  ],
});
const schema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([recordsHistory])],
});
const retentionMarker = defineTable("retention_marker", { id: integer().primaryKey() });
const retentionSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([recordsHistory, defineTableHistory({
    current: retentionMarker,
    versions: [tableVersion({ schemaVersion: 3, table: retentionMarker, migration: createTable(retentionMarker) })],
  })])],
});
const day = 86_400_000;

async function fixture(context: TestContext, targetVersion = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-migration-backup-"));
  captureTestOutput(context, process.stdout, text => text.startsWith(DATABASE_LOG_PREFIX));
  const database = new Database(path.join(directory, "source.sqlite3"));
  context.after(async () => {
    if (database.open) database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  database.pragma("journal_mode = WAL");
  database.pragma("wal_autocheckpoint = 0");
  applyWorkbenchDatabaseSchema(database, schema, { targetVersion });
  const backups = path.join(directory, "backups", "source.sqlite3");
  return { database, directory, backups };
}

async function completedBackups(directory: string) {
  try {
    return (await fs.readdir(directory)).filter(name => name.endsWith(".sqlite3"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("backup includes committed WAL data and the schema removed by the upgrade", async context => {
  const { database, backups } = await fixture(context);
  const diagnostics: string[] = [];
  database.prepare("INSERT INTO records VALUES (1, 'only-in-old-schema', 'retained')").run();
  database.exec("CREATE TABLE extension(payload BLOB); INSERT INTO extension VALUES (x'010203')");
  assert.ok((await fs.stat(`${database.name}-wal`)).size > 0);
  await migrateWorkbenchDatabase(database, schema, {
    diagnostic: (level, message) => { if (level === "info") diagnostics.push(message); },
  });
  assert.ok(diagnostics.some(message => message.includes("backup")));
  assert.ok(diagnostics.some(message => message.includes("verify")));
  assert.ok(diagnostics.some(message => message.includes("migrate")));
  const names = await completedBackups(backups);
  assert.equal(names.length, 1, "upgrade requires one completed backup");
  const backup = new Database(path.join(backups, names[0]!), { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(backup.prepare("SELECT * FROM records").all(), [{ id: 1, legacy: "only-in-old-schema", kept: "retained" }]);
    assert.deepEqual(backup.prepare("SELECT payload FROM extension").get(), { payload: Buffer.from([1, 2, 3]) });
    assert.deepEqual(backup.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.deepEqual(database.prepare("SELECT * FROM records").all(), [{ id: 1, kept: "retained" }]);
  } finally { backup.close(); }
  const reported = diagnostics.length;
  await migrateWorkbenchDatabase(database, schema, {
    diagnostic: (level, message) => { if (level === "info") diagnostics.push(message); },
  });
  assert.equal(diagnostics.length, reported);
  assert.deepEqual(await completedBackups(backups), names, "unchanged schema must not create another backup");
});

test("same-version startup does not inspect retained backups", async context => {
  const { database, backups } = await fixture(context, 2);
  await fs.mkdir(backups, { recursive: true });
  const readDirectory = fs.readdir.bind(fs);
  let backupReads = 0;
  context.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === backups) backupReads++;
    return readDirectory(...args);
  });
  await migrateWorkbenchDatabase(database, schema);
  assert.equal(backupReads, 0, "A current schema must not scan backup history");
});

test("retention prunes only expired duplicates protected by the fresh verified checkpoint", async context => {
  const { database, backups } = await fixture(context, 2);
  await fs.mkdir(backups, { recursive: true });
  const now = Date.now();
  const history: string[] = [];
  for (let index = 0; index < 6; index++) {
    const file = path.join(backups, `${randomUUID()}.sqlite3`);
    const backup = new Database(file);
    applyWorkbenchDatabaseSchema(backup, schema, { targetVersion: 2 });
    backup.close();
    const time = new Date(now - 10 * day + index);
    await fs.utimes(file, time, time);
    history.push(file);
  }
  const checked: string[] = [];
  const pragma = Database.prototype.pragma;
  context.mock.method(Database.prototype, "pragma", function (this: Database.Database, ...args: Parameters<typeof pragma>) {
    if (args[0] === "quick_check" && history.includes(this.name)) checked.push(this.name);
    return pragma.apply(this, args);
  });
  await migrateWorkbenchDatabase(database, retentionSchema, { now: () => now });
  assert.deepEqual(checked, [], "retention must trust the checkpoint verified by this migration instead of rescanning history");
  assert.equal((await completedBackups(backups)).length, 5);
});

test("retention leaves expired duplicates from historical schema generations untouched", async context => {
  const { database, backups } = await fixture(context, 2);
  await fs.mkdir(backups, { recursive: true });
  const history: string[] = [];
  const expiredAt = Date.now() - 10 * day;
  for (let index = 0; index < 6; index++) {
    const file = path.join(backups, `${randomUUID()}.sqlite3`);
    const backup = new Database(file);
    applyWorkbenchDatabaseSchema(backup, schema, { targetVersion: 1 });
    backup.close();
    await fs.utimes(file, new Date(expiredAt + index), new Date(expiredAt + index));
    history.push(file);
  }
  const pragma = Database.prototype.pragma;
  const checked: string[] = [];
  context.mock.method(Database.prototype, "pragma", function (this: Database.Database, ...args: Parameters<typeof pragma>) {
    if (args[0] === "quick_check" && history.includes(this.name)) checked.push(this.name);
    return pragma.apply(this, args);
  });
  await migrateWorkbenchDatabase(database, retentionSchema);
  assert.deepEqual(checked, [], "an unrelated upgrade must not inspect historical checkpoint contents");
  for (const file of history) assert.ok((await fs.stat(file)).isFile());
});

test("explicit same-version backups capture WAL data without migrating or changing the source", async context => {
  const { database, directory } = await fixture(context, 2);
  database.prepare("INSERT INTO records VALUES (1, 'retained')").run();
  database.exec("CREATE TABLE extension(payload BLOB); INSERT INTO extension VALUES (x'010203')");
  const source = new Database(database.name, { readonly: true, fileMustExist: true });
  try {
    const backupPath = await preserveWorkbenchDatabaseBackup(source, path.join(directory, "rollout"));
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), 2);
      assert.deepEqual(backup.prepare("SELECT * FROM records").all(), [{ id: 1, kept: "retained" }]);
      assert.deepEqual(backup.prepare("SELECT * FROM extension").all(), [{ payload: Buffer.from([1, 2, 3]) }]);
      database.prepare("UPDATE records SET kept = 'newer'").run();
      assert.deepEqual(backup.prepare("SELECT * FROM records").all(), [{ id: 1, kept: "retained" }]);
      assert.equal(source.pragma("user_version", { simple: true }), 2);
      assert.deepEqual(source.prepare("SELECT * FROM records").all(), [{ id: 1, kept: "newer" }]);
    } finally { backup.close(); }
  } finally { source.close(); }
});

test("an unwritable backup destination prevents any schema change", async context => {
  const { database, directory } = await fixture(context);
  await fs.writeFile(path.join(directory, "backups"), "not a directory");
  await assert.rejects(migrateWorkbenchDatabase(database, schema), /backup/i);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(database.prepare("SELECT legacy FROM records").all(), []);
});

test("migration cannot change the schema before its rollback checkpoint is acknowledged", async context => {
  const { database } = await fixture(context);
  database.prepare("INSERT INTO records VALUES (1, 'old value', 'kept value')").run();
  const options = {
    targetVersion: 2,
    beforeMigration: async (backupPath: string) => {
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(backup.pragma("user_version", { simple: true }), 1);
        assert.deepEqual(backup.prepare("SELECT * FROM records").get(), {
          id: 1, legacy: "old value", kept: "kept value",
        });
      } finally { backup.close(); }
      throw new Error("checkpoint acknowledgement rejected");
    },
  };
  await assert.rejects(migrateWorkbenchDatabase(database, schema, options), /checkpoint acknowledgement rejected/u);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(database.prepare("SELECT * FROM records").get(), {
    id: 1, legacy: "old value", kept: "kept value",
  });
});

test("rollback restores removed schema and WAL data after a successful upgrade, then permits retry", async context => {
  const { database } = await fixture(context);
  const databasePath = database.name;
  database.exec("INSERT INTO records VALUES (1, 'old-only value', 'kept value')");
  let checkpoint = "";
  await migrateWorkbenchDatabase(database, schema, { beforeMigration: value => { checkpoint = value; } });
  database.exec("UPDATE records SET kept = 'candidate value'");
  assert.throws(() => database.prepare("SELECT legacy FROM records").get(), /column/);
  database.close();
  await restoreWorkbenchDatabaseBackup(checkpoint, databasePath);
  const restored = new Database(databasePath);
  try {
    assert.equal(restored.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(restored.prepare("SELECT * FROM records").all(), [
      { id: 1, legacy: "old-only value", kept: "kept value" },
    ]);
    await migrateWorkbenchDatabase(restored, schema);
    assert.equal(restored.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(restored.prepare("SELECT * FROM records").all(), [{ id: 1, kept: "kept value" }]);
  } finally { restored.close(); }
});

test("an invalid backup is not published and cannot permit migration", async context => {
  const { database, backups } = await fixture(context);
  context.mock.method(database, "backup", async (destination: string) => {
    await fs.writeFile(destination, "damaged backup");
    return { totalPages: 0, remainingPages: 0 };
  });
  await assert.rejects(migrateWorkbenchDatabase(database, schema), /backup/i);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(await completedBackups(backups), []);
});

test("a readable backup with the wrong schema version cannot permit migration", async context => {
  const { database, backups } = await fixture(context);
  context.mock.method(database, "backup", async (destination: string) => {
    const empty = new Database(destination);
    empty.exec("CREATE TABLE wrong(value TEXT)");
    empty.close();
    return { totalPages: 1, remainingPages: 0 };
  });
  await assert.rejects(migrateWorkbenchDatabase(database, schema), /backup/i);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(await completedBackups(backups), []);
});

test("failed migration retains a readable pre-upgrade backup", async context => {
  const { database, backups } = await fixture(context);
  database.prepare("INSERT INTO records VALUES (?, ?, 'duplicate')").run(1, "first");
  database.prepare("INSERT INTO records VALUES (?, ?, 'duplicate')").run(2, "second");
  await assert.rejects(migrateWorkbenchDatabase(database, schema), /UNIQUE/);
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  const names = await completedBackups(backups);
  assert.equal(names.length, 1, "rollback must not discard its pre-upgrade backup");
  const backup = new Database(path.join(backups, names[0]!), { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(backup.prepare("SELECT * FROM records ORDER BY id").all(), database.prepare("SELECT * FROM records ORDER BY id").all());
  } finally { backup.close(); }
});

for (const ages of [[1, 2, 3, 4, 5, 6, 7], [0.1, 0.2, 0.3, 0.4, 0.5, 1, 2, 3, 4]]) {
  test(`retention keeps newest five and every backup at most three days old (${ages.length} backups)`, async context => {
    const { database, directory, backups } = await fixture(context, 2);
    const now = Date.UTC(2026, 8, 8);
    await fs.mkdir(backups, { recursive: true });
    const names = ages.map(() => `${randomUUID()}.sqlite3`);
    for (const [index, name] of names.entries()) {
      const file = path.join(backups, name);
      const backup = new Database(file);
      applyWorkbenchDatabaseSchema(backup, schema);
      backup.close();
      const time = new Date(now - ages[index]! * day);
      await fs.utimes(file, time, time);
    }
    const unrelated = path.join(directory, "backups", "other.sqlite3");
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, names[0]!), "other database");
    await fs.writeFile(path.join(backups, "manual.sqlite3"), "manual backup");
    await fs.writeFile(path.join(backups, `${randomUUID()}.partial`), "incomplete");
    const directoryName = `${randomUUID()}.sqlite3`;
    await fs.mkdir(path.join(backups, directoryName));
    await migrateWorkbenchDatabase(database, retentionSchema, { now: () => now });
    const remaining = new Set(await fs.readdir(backups));
    for (const [index, name] of names.entries()) {
      assert.equal(remaining.has(name), index < 4 || ages[index]! <= 3, "the new checkpoint counts towards the five retained backups");
    }
    assert.ok(remaining.has("manual.sqlite3"));
    assert.ok(remaining.has(directoryName));
    assert.ok([...remaining].some(name => name.endsWith(".partial")));
    assert.deepEqual(await fs.readdir(unrelated), [names[0]!]);
  });
}

test("retention failure warns but leaves the database usable", async context => {
  const { database, backups } = await fixture(context, 2);
  await fs.mkdir(backups, { recursive: true });
  for (let index = 0; index < 6; index++) {
    const file = path.join(backups, `${randomUUID()}.sqlite3`);
    const backup = new Database(file);
    applyWorkbenchDatabaseSchema(backup, schema);
    backup.close();
    await fs.utimes(file, new Date(0), new Date(0));
  }
  const warnings = context.mock.method(console, "warn", () => {});
  context.mock.method(fs, "unlink", async () => { throw new Error("cleanup denied"); });
  await migrateWorkbenchDatabase(database, retentionSchema);
  assert.ok(warnings.mock.calls.length > 0, "cleanup failures must remain visible");
  assert.equal((await completedBackups(backups)).length, 7);
  assert.deepEqual(database.prepare("SELECT * FROM records").all(), []);
});

test("empty first installation creates no backup", async context => {
  const { database, backups } = await fixture(context);
  database.close();
  const fresh = new Database(path.join(path.dirname(database.name), "fresh.sqlite3"));
  try {
    await migrateWorkbenchDatabase(fresh, schema);
    assert.equal(fresh.pragma("user_version", { simple: true }), schema.currentVersion);
    assert.deepEqual(await completedBackups(path.join(path.dirname(backups), "fresh.sqlite3")), []);
  } finally { fresh.close(); }
});

test("retention preserves the latest checkpoint per schema and never prunes failed upgrades", async context => {
  const { database, backups } = await fixture(context);
  const checkpoint = await preserveWorkbenchDatabaseBackup(database, backups);
  await fs.utimes(checkpoint, new Date(0), new Date(0));
  applyWorkbenchDatabaseSchema(database, schema);
  for (let index = 0; index < 6; index++) {
    const backup = await preserveWorkbenchDatabaseBackup(database, backups);
    await fs.utimes(backup, new Date(index + 1), new Date(index + 1));
  }
  const archive = await preserveWorkbenchDatabaseBackup(database, path.join(backups, "failed-upgrades"));
  await fs.utimes(archive, new Date(0), new Date(0));
  await migrateWorkbenchDatabase(database, retentionSchema);
  assert.ok((await fs.stat(checkpoint)).isFile(), "last checkpoint for old schema must survive retention");
  assert.ok((await fs.stat(archive)).isFile(), "failed upgrades are outside automatic retention");
  assert.equal((await completedBackups(backups)).length, 6);
});
