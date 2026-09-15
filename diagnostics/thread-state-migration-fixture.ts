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
import { workbenchDatabaseSchema } from "../daemon/server/database/workbench-database-schema";
import WorkbenchThreadStateMigration, { readThreadStateRelationshipSources } from "../daemon/server/database/thread-state/WorkbenchThreadStateMigration";
import WorkbenchProjectMigration from "../daemon/server/database/project/WorkbenchProjectMigration";
import { WorkbenchProjectRelocationsSchema } from "../daemon/server/database/project/workbench-project-persistence";
import { discoverProjectIdentities } from "../daemon/server/lib/project";

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
          if (!["cwd", "project_root", "native_location", "root_path", "workspace_path", "repository_root", "workspace_root"].includes(column)) continue;
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
  const discovery = await discoverProjectIdentities();
  let relocations = WorkbenchProjectRelocationsSchema.parse({});
  try {
    relocations = WorkbenchProjectRelocationsSchema.parse(JSON.parse(
      await fs.readFile(path.join(sourceRoot, ".workbench", "project-identity-relocations.json"), "utf8"),
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
    return { databasePath, runtimeDirectory, alreadyImported, discovery, relocations };
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
    const beforeProjects = new Map(workbenchDatabaseSchema.currentTables
      .filter(table => ["project_id", "scope_project_id"].some(column => column in table.columns))
      .filter(table => !["workbench_project_roots", "workbench_project_aliases"].includes(table.name))
      .filter(table => database.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table.name))
      .map(table => [table.name, database.prepare(`SELECT * FROM "${table.name}"`).all() as Record<string, string | number | null>[]]));
    const beforeSidebar = new Map(workbenchDatabaseSchema.currentTables
      .filter(table => table.name.startsWith("workbench_sidebar_") && !beforeProjects.has(table.name))
      .map(table => [table.name, database.prepare(`SELECT * FROM "${table.name}"`).all() as Record<string, string | number | null>[]]));
    const converted = new WorkbenchProjectMigration(database).run(workbenchDatabaseSchema, source.discovery, source.relocations);
    const aliases = new Map(converted.aliases.map(alias => [alias.alias, alias.projectId]));
    for (const [table, rows] of new Map([...beforeProjects, ...beforeSidebar])) {
      const retainedRows = table === "workbench_search_documents" ? rows.filter(row => row.project_id !== null) : rows;
      const expected = retainedRows.map<Record<string, string | number | null>>(row => ({
        ...row,
        ...("project_id" in row && row.project_id !== null ? { project_id: aliases.get(String(row.project_id)) ?? row.project_id } : {}),
        ...("scope_project_id" in row && row.scope_project_id !== null ? { scope_project_id: aliases.get(String(row.scope_project_id)) ?? row.scope_project_id } : {}),
      })).map(row => {
        if (table !== "workbench_search_documents" || row.project_id === null) return row;
        if (row.kind === "project") return {
          ...row, document_key: `project:${row.project_id}`, target: row.project_id,
          search_text: `${row.title} ${row.project_id} ${row.detail}`,
        };
        if (row.kind === "file") return { ...row, document_key: `file:${row.project_id}:${row.target}`, detail: row.project_id };
        return row;
      });
      const actual = (database.prepare(`SELECT * FROM "${table}"`).all() as typeof rows)
        .filter(row => table !== "workbench_search_documents" || row.project_id !== null);
      // Rekeying may reorder PK-backed scans. Compare complete facts as a multiset.
      const columns = Object.keys(workbenchDatabaseSchema.currentTables.find(candidate => candidate.name === table)!.columns);
      const sorted = (values: typeof rows) => [...values].sort((left, right) => {
        for (const column of columns) {
          const a = left[column];
          const b = right[column];
          if (a === b) continue;
          if (a === null) return -1;
          if (b === null) return 1;
          return a < b ? -1 : 1;
        }
        return 0;
      });
      assert.deepEqual(sorted(actual), sorted(expected), `${table} must preserve every non-project fact`);
    }
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.doesNotThrow(() => new WorkbenchProjectMigration(database).run(workbenchDatabaseSchema, source.discovery));
    assert.deepEqual(migration.run(workbenchDatabaseSchema, [], 4), { imported: false });
    assert.deepEqual(database.prepare("SELECT completed_at FROM workbench_thread_state_import WHERE id = 1").get(), receipt);
    console.log(`real project source converted: ${beforeProjects.size} project-bearing tables, ${aliases.size} retained addresses`);
  } finally {
    database.close();
  }
}
