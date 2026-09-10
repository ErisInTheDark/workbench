/*
 * Exports:
 * - captureThreadStateMigrationSource: capture a consistent database and unchanged relationship files without starting providers.
 * - verifyThreadStateMigrationSource: exercise real copied conversion, rollback, retry and current-state readback without booting a runtime.
 * - installThreadStateMigrationSource: install the converted capture with private runtime path references.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { workbenchDatabaseSchema } from "../daemon/orchestrator/database/workbench-database-schema";
import WorkbenchThreadStateMigration, { readThreadStateRelationshipSources } from "../daemon/orchestrator/database/thread-state/WorkbenchThreadStateMigration";

export async function installThreadStateMigrationSource(
  source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>,
  project: string,
  privateRoot: string,
) {
  const target = path.join(project, ".workbench", "workbench.sqlite3");
  const captured = new Database(source.databasePath, { readonly: true, fileMustExist: true });
  try { await captured.backup(target); }
  finally { captured.close(); }
  const database = new Database(target, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      for (const table of workbenchDatabaseSchema.currentTables) {
        for (const column of Object.keys(table.columns)) {
          if (!["cwd", "project_root", "native_location"].includes(column)) continue;
          const values = database.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table.name}"`).all() as Array<{ value: string | null }>;
          for (const { value } of values) {
            if (!value) continue;
            const key = createHash("sha256").update(value).digest("hex");
            const isolated = path.join(privateRoot, "retained-locations", key);
            database.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE "${column}" = ?`).run(isolated, value);
          }
        }
      }
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    })();
    database.pragma("foreign_keys = ON");
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    const counts = {
      threads: database.prepare("SELECT count(*) FROM workbench_threads").pluck().get(),
      states: database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get(),
      relationships: database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get(),
    };
    console.log("isolated startup uses converted source counts", counts);
    return counts;
  } finally { database.close(); }
}

async function readRelationshipFiles(runtimeDirectory: string) {
  const files = new Map<string, string>();
  const read = async (relative: string) => {
    const file = path.join(runtimeDirectory, relative);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Relationship capture must not follow links");
    files.set(relative, await fs.readFile(file, "utf8"));
  };
  try {
    await read("subagents.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = path.join(runtimeDirectory, "subagents");
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return files;
  }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Relationship capture must not follow a directory link");
  const entries = await fs.readdir(directory);
  for (const name of entries.sort()) if (name.endsWith(".json")) await read(path.join("subagents", name));
  return files;
}

export async function captureThreadStateMigrationSource(sourceRoot: string, privateRoot: string) {
  const directory = await fs.mkdtemp(path.join(privateRoot, "thread-state-source-"));
  const databasePath = path.join(directory, "workbench.sqlite3");
  const runtimeDirectory = path.join(directory, "runtime");
  const sourceRuntime = path.join(sourceRoot, ".workbench", "runtime");
  const before = await readRelationshipFiles(sourceRuntime);
  const database = new Database(path.join(sourceRoot, ".workbench", "workbench.sqlite3"), {
    readonly: true, fileMustExist: true,
  });
  try {
    await database.backup(databasePath);
  } finally {
    database.close();
  }
  // A file-backed relationship mutation cannot share SQLite's read transaction.
  // Refuse a moving source rather than call a mixed-time capture migration proof.
  assert.deepEqual(await readRelationshipFiles(sourceRuntime), before, "Relationship source changed during database capture");
  for (const [relative, contents] of before) {
    const file = path.join(runtimeDirectory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  await fs.mkdir(runtimeDirectory, { recursive: true });
  const captured = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(captured.pragma("integrity_check", { simple: true }), "ok");
    const receiptTable = captured.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_import'").get();
    const alreadyImported = Boolean(receiptTable && captured.prepare("SELECT 1 FROM workbench_thread_state_import WHERE id = 1").get());
    return { databasePath, runtimeDirectory, alreadyImported };
  } finally {
    captured.close();
  }
}

export async function verifyThreadStateMigrationSource(source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>) {
  const relationshipFiles = await readRelationshipFiles(source.runtimeDirectory);
  const relationships = source.alreadyImported ? [] : await readThreadStateRelationshipSources(source.runtimeDirectory);
  const database = new Database(source.databasePath, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    const migration = new WorkbenchThreadStateMigration(database);
    const version = database.pragma("user_version", { simple: true });
    if (!source.alreadyImported) {
      const documents = () => ({
        projects: database.prepare("SELECT * FROM workbench_thread_state_projects ORDER BY project_id").all(),
        globals: database.prepare("SELECT * FROM workbench_thread_state_globals ORDER BY id").all(),
        titles: database.prepare("SELECT * FROM workbench_thread_title_history ORDER BY project_id, harness_id, thread_id, title").all(),
      });
      const before = documents();
      // Fail source retirement after conversion/readback, before the receipt.
      const receipt = workbenchDatabaseSchema.currentTables.find(table => table.name === "workbench_thread_state_import");
      assert.ok(receipt, "The serving schema must include the relational cutover");
      database.exec("CREATE TEMP TRIGGER thread_state_fail_retirement BEFORE DELETE ON main.workbench_thread_state_projects BEGIN SELECT RAISE(ABORT, 'diagnostic conversion failure'); END");
      if (before.projects.length) {
        assert.throws(() => migration.run(workbenchDatabaseSchema, relationships, 1), /diagnostic conversion failure/);
        assert.equal(database.pragma("user_version", { simple: true }), version);
        assert.deepEqual(documents(), before, "Failed conversion must restore every captured document and title");
        assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_import'").get(), undefined);
      }
      database.exec("DROP TRIGGER thread_state_fail_retirement");
      assert.deepEqual(migration.run(workbenchDatabaseSchema, relationships, 2), { imported: true });
      assert.equal(database.prepare("SELECT count(*) FROM workbench_thread_state_projects").pluck().get(), 0);
      assert.equal(database.prepare("SELECT count(*) FROM workbench_thread_state_globals").pluck().get(), 0);
      console.log(`real thread-state source converted and read back: ${before.projects.length} project documents, ${relationships.length} parent allocations`);
    } else {
      console.log("real thread-state source is already relational: validating current facts and no-op import, not replaying legacy conversion");
    }
    const receipt = database.prepare("SELECT completed_at FROM workbench_thread_state_import WHERE id = 1").get();
    assert.ok(receipt);
    assert.deepEqual(migration.run(workbenchDatabaseSchema, [], 3), { imported: false });
    assert.deepEqual(database.prepare("SELECT completed_at FROM workbench_thread_state_import WHERE id = 1").get(), receipt);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(await readRelationshipFiles(source.runtimeDirectory), relationshipFiles, "Conversion must leave relationship recovery files untouched");
  } finally {
    database.close();
  }
}
