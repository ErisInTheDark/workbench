/*
 * Exports:
 * - captureThreadStateMigrationSource: capture a consistent database directly into its private runtime location.
 * - verifyThreadStateMigrationSource: compare the daemon-upgraded capture against its pre-upgrade checkpoint.
 * - isolateThreadStateMigrationSource: rewrite the verified capture's filesystem addresses in place.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import { tableForeignKeys } from "../../shared/database/schema/schema-definition";

type CopyOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: Database.BackupMetadata) => void;
};

export async function captureThreadStateMigrationSource(sourceDatabasePath: string, databasePath: string, options: CopyOptions = {}) {
  options.signal?.throwIfAborted();
  const database = new Database(sourceDatabasePath, {
    readonly: true, fileMustExist: true,
  });
  let version: number;
  try {
    // Keep one source snapshot across incremental backup steps. Without it,
    // writes from the live daemon can restart every batch indefinitely.
    database.exec("BEGIN");
    version = database.pragma("user_version", { simple: true }) as number;
    assert.ok(version >= 33, "Scenario source must be a current migrated database");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    options.signal?.throwIfAborted();
    // Reserve exclusively: cleanup may delete only the destination we created.
    const reservation = await fs.open(databasePath, "wx");
    await reservation.close();
    try {
      await database.backup(databasePath, {
        progress: progress => {
          options.signal?.throwIfAborted();
          options.onProgress?.(progress);
          options.signal?.throwIfAborted();
          return 100;
        },
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      try { await fs.unlink(databasePath); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Database capture and partial-file cleanup failed");
      }
      throw error;
    }
  } finally { database.close(); }
  return { databasePath, version };
}

const quote = (name: string) => `"${name.replaceAll("\"", "\"\"")}"`;

/** The daemon's first checkpoint at the captured schema is the pristine pre-upgrade copy. */
async function findPreUpgradeCheckpoint(databasePath: string, version: number) {
  const directory = path.join(path.dirname(databasePath), "backups", path.basename(databasePath));
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates: { filePath: string; modifiedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite3")) continue;
    const filePath = path.join(directory, entry.name);
    const checkpoint = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      if (checkpoint.pragma("user_version", { simple: true }) !== version) continue;
    } finally { checkpoint.close(); }
    candidates.push({ filePath, modifiedAt: (await fs.stat(filePath)).mtimeMs });
  }
  return candidates.sort((a, b) => a.modifiedAt - b.modifiedAt)[0]?.filePath ?? null;
}

/**
 * Run after the real daemon upgraded the capture. Its startup already migrated
 * (idempotently, on every reopen) and verified foreign keys and readback; this
 * proves every retained relational fact survived, natively in SQLite. No full
 * integrity_check: index/table drift would mean a SQLite or disk fault, not a
 * migration defect.
 */
export async function verifyThreadStateMigrationSource(source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>) {
  const checkpoint = await findPreUpgradeCheckpoint(source.databasePath, source.version);
  const pending = source.version < workbenchDatabaseSchema.currentVersion;
  assert.ok(checkpoint || !pending, "An upgraded database must leave its verified pre-upgrade checkpoint");
  const database = new Database(source.databasePath, { fileMustExist: true });
  try {
    // Read-only scans: mappings avoid copying every page into SQLite's cache.
    database.pragma("mmap_size = 2147483648");
    assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
    let verified = 0;
    if (checkpoint) {
      database.prepare("ATTACH DATABASE ? AS source").run(checkpoint);
      database.pragma("source.mmap_size = 2147483648");
      try {
        const retained = workbenchDatabaseSchema.currentTables.filter(table =>
          !table.name.startsWith("workbench_thread_state_")
          && !table.name.startsWith("workbench_git_arc_proposal_diff")
          && database.prepare("SELECT 1 FROM source.sqlite_schema WHERE type = 'table' AND name = ?").get(table.name));
        const owner = (expression: string) =>
          `COALESCE((SELECT project_id FROM main.workbench_project_aliases WHERE alias = ${expression}), ${expression})`;
        for (const table of retained) {
          const existing = new Set((database.prepare(`PRAGMA source.table_info(${quote(table.name)})`).all() as Array<{ name: string }>)
            .map(column => column.name));
          const columns = Object.keys(table.columns).filter(column => existing.has(column));
          const remapped = new Set(tableForeignKeys(table).filter(key => key.target.table === "workbench_projects")
            .flatMap(key => key.columns));
          if (table.name === "workbench_projects") remapped.add("id");
          const value = (column: string) => remapped.has(column) ? owner(`s.${quote(column)}`) : `s.${quote(column)}`;
          const expected = (column: string) => {
            if (table.name !== "workbench_search_documents" || !remapped.has("project_id")) return value(column);
            // Project-scoped search keys embed the owner, so a remapped owner rewrites them.
            const project = value("project_id");
            const rewrite = { project: {
              document_key: `'project:' || ${project}`, target: project,
              search_text: `s."title" || ' ' || ${project} || ' ' || s."detail"`,
            }, file: {
              document_key: `'file:' || ${project} || ':' || s."target"`, detail: project,
            } } as Record<string, Record<string, string>>;
            const cases = Object.entries(rewrite).filter(([, columns]) => columns[column])
              .map(([kind, columns]) => `WHEN s."kind" = '${kind}' THEN ${columns[column]}`);
            return cases.length
              ? `CASE WHEN ${project} IS s."project_id" THEN ${value(column)} ${cases.join(" ")} ELSE ${value(column)} END`
              : value(column);
          };
          const list = columns.map(quote).join(", ");
          const before = `SELECT ${columns.map(column => `${expected(column)} AS ${quote(column)}`).join(", ")} FROM source.${quote(table.name)} AS s`;
          const after = table.name === "workbench_project_aliases"
            // New aliases may appear; retained aliases must still resolve to their original owners.
            ? `SELECT ${list} FROM main.${quote(table.name)} WHERE alias IN (SELECT alias FROM source.${quote(table.name)})`
            : `SELECT ${list} FROM main.${quote(table.name)}`;
          const result = database.prepare(`
            WITH before AS (${before}), after AS (${after})
            SELECT (SELECT count(*) FROM (SELECT * FROM before EXCEPT SELECT * FROM after)) AS missing,
              (SELECT count(*) FROM (SELECT * FROM after EXCEPT SELECT * FROM before)) AS added,
              (SELECT count(*) FROM before) AS beforeCount, (SELECT count(*) FROM after) AS afterCount
          `).get() as { missing: number; added: number; beforeCount: number; afterCount: number };
          assert.deepEqual({ missing: result.missing, added: result.added }, { missing: 0, added: 0 },
            `${table.name} must retain every current relational fact`);
          if (table.name !== "workbench_project_aliases") {
            assert.equal(result.afterCount, result.beforeCount, `${table.name} must retain its row count`);
          }
          verified += 1;
        }
      } finally { database.exec("DETACH DATABASE source"); }
    }
    console.log(`database schema ${source.version} -> ${workbenchDatabaseSchema.currentVersion}; ${checkpoint
      ? `${verified} relational tables verified against the pre-upgrade checkpoint`
      : "no data-changing startup steps, nothing to compare"}`);
  } finally { database.close(); }
}

export async function isolateThreadStateMigrationSource(
  source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>,
  privateRoot: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const database = new Database(source.databasePath, { fileMustExist: true });
  try {
    database.pragma("mmap_size = 2147483648");
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      // Commit refuses any dangling reference without scanning every table.
      database.pragma("defer_foreign_keys = ON");
      for (const table of workbenchDatabaseSchema.currentTables) {
        for (const column of Object.keys(table.columns)) {
          if (!["cwd", "project_root", "native_location", "root_path", "workspace_path", "repository_root", "workspace_root", "worktree_root", "profile_path"].includes(column)) continue;
          const values = database.prepare(`SELECT DISTINCT "${column}" AS value FROM "${table.name}"`).all() as Array<{ value: string | null }>;
          for (const { value } of values) {
            if (!value) continue;
            const key = createHash("sha256").update(value).digest("hex");
            const isolated = path.join(privateRoot, "retained-locations", key);
            database.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE "${column}" = ?`).run(isolated, value);
          }
        }
      }
    })();
    const counts = {
      threads: database.prepare("SELECT count(*) FROM workbench_threads").pluck().get(),
      states: database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get(),
      relationships: database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get(),
    };
    console.log("isolated startup uses current source counts", counts);
    return counts;
  } finally { database.close(); }
}
