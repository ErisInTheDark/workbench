/*
 * Exports:
 * - captureThreadStateMigrationSource: capture a consistent runtime database and an independent pristine test baseline.
 * - verifyThreadStateMigrationSource: compare init-only startup against the pristine baseline, then check the daemon-run database.
 * - isolateThreadStateMigrationSource: rewrite the verified capture's filesystem addresses in place.
 * - compareRetainedFacts: verify every retained relational fact against an attached pristine source.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import WorkbenchDatabaseController from "../../daemon/server/database/WorkbenchDatabaseController";
import { tableForeignKeys } from "../../shared/database/schema/schema-definition";
import databaseReleases from "../../shared/workbench/database/schema/releases";
import { nativeLocationKey } from "../../daemon/server/database/thread-identity/native-location-key";

type CopyOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: Database.BackupMetadata) => void;
};

export async function captureThreadStateMigrationSource(sourceDatabasePath: string, databasePath: string, options: CopyOptions = {}) {
  options.signal?.throwIfAborted();
  const checkpointPath = `${databasePath}.source`;
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
      await fs.copyFile(databasePath, checkpointPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      try { await fs.unlink(databasePath); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Database capture and partial-file cleanup failed");
      }
      throw error;
    }
  } finally { database.close(); }
  return { databasePath, version, checkpointPath };
}

const quote = (name: string) => `"${name.replaceAll("\"", "\"\"")}"`;

/**
 * Releases that intentionally change retained rows. A source older than the release receives the same effect before
 * comparison; every other retained fact must survive migration exactly.
 */
const RELEASE_DATA_EFFECTS: ReadonlyArray<{ version: number; apply(database: Database.Database): void }> = [{
  version: databaseReleases.captureGapTurns.version,
  // Gap turns move into anchors; open gaps no provider window could re-read are dropped.
  apply: database => database.exec(`
    CREATE TABLE transcript_capture_gap_turns(
      gap_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, reconciled_at INTEGER,
      PRIMARY KEY(gap_id, turn_id)
    );
    INSERT INTO transcript_capture_gap_turns
    SELECT id, thread_id, turn_id, CASE WHEN state = 'reconciled' THEN closed_at END
    FROM transcript_capture_gaps WHERE turn_id IS NOT NULL;
    DELETE FROM transcript_capture_gaps WHERE state = 'open' AND turn_id IS NULL;
  `),
}];

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

/** Compare every retained relational fact of `main` against `source`, natively in SQLite. */
export function compareRetainedFacts(database: Database.Database) {
  database.function("migration_location", { deterministic: true }, (value: string) => nativeLocationKey(value));
  const projectColumns = database.prepare("PRAGMA source.table_info(workbench_projects)").all() as Array<{ name: string }>;
  const recovery = projectColumns.some(column => column.name === "identity_key") ? `recovered AS (
    SELECT shadow.id AS shadow, historical.id AS owner, layout.layout_id
    FROM source.workbench_projects shadow
    JOIN source.workbench_project_roots root ON root.project_id = shadow.id
    JOIN main.workbench_project_aliases alias ON alias.alias = shadow.id
    JOIN source.workbench_projects historical ON historical.id = alias.project_id
    LEFT JOIN source.workbench_sidebar_project_layouts layout ON layout.project_id = shadow.id
    WHERE shadow.kind = 'git' AND historical.kind = 'historical'
      AND historical.identity_key LIKE 'local://%'
      AND migration_location(substr(historical.identity_key, 9)) = migration_location(root.root_path)
      AND (SELECT count(*) FROM source.workbench_project_roots r WHERE r.project_id = shadow.id) = 1
      AND NOT EXISTS (SELECT 1 FROM source.workbench_project_roots r WHERE r.project_id = historical.id)
  )` : "recovered AS (SELECT NULL AS shadow, NULL AS owner, NULL AS layout_id WHERE 0)";
  let verified = 0;
  const retained = workbenchDatabaseSchema.currentTables.filter(table =>
    !table.name.startsWith("workbench_thread_state_")
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
      if (table.name === "git_claim_imports" && (column === "state" || column === "run_id")) {
        return `CASE WHEN s.state = 'processing' AND EXISTS (
          SELECT 1 FROM recovered r WHERE s.project_id IN (r.shadow, r.owner)
        ) THEN ${column === "state" ? "'pending'" : "NULL"} ELSE ${value(column)} END`;
      }
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
    // Action and setting search rows are rebuilt from code definitions on every start, not retained data.
    const retainedOnly = (alias: string, source = false) => {
      const conditions: string[] = [];
      if (table.name === "workbench_search_documents") {
        conditions.push(`${alias}"kind" NOT IN ('action', 'projectSetting')`);
        if (source) conditions.push("s.project_id NOT IN (SELECT shadow FROM recovered)");
      }
      if (source && table.name === "workbench_projects") conditions.push("s.id NOT IN (SELECT owner FROM recovered)");
      if (source && table.name === "workbench_sidebar_project_layouts") conditions.push("s.project_id NOT IN (SELECT shadow FROM recovered)");
      if (source && table.name === "workbench_sidebar_layouts") conditions.push("s.id NOT IN (SELECT layout_id FROM recovered WHERE layout_id IS NOT NULL)");
      if (source && table.name === "git_claim_imports") conditions.push(`NOT EXISTS (
        SELECT 1 FROM recovered r JOIN source.git_claim_imports other
          ON other.root_id = s.root_id AND other.checkpoint_ref = s.checkpoint_ref
        WHERE (s.project_id = r.shadow AND other.project_id = r.owner
          AND (other.state = 'completed' OR (s.state <> 'completed' AND other.updated_at >= s.updated_at)))
          OR (s.project_id = r.owner AND other.project_id = r.shadow AND s.state <> 'completed'
          AND (other.state = 'completed' OR other.updated_at > s.updated_at))
      )`);
      return conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    };
    const deduplicate = ["git_claim_thread_file_days", "workbench_sidebar_pinned_imports"].includes(table.name);
    const before = `SELECT ${deduplicate ? "DISTINCT " : ""}${columns.map(column => `${expected(column)} AS ${quote(column)}`).join(", ")}
      FROM source.${quote(table.name)} AS s${retainedOnly("s.", true)}`;
    const openWorld = table.name === "workbench_project_aliases";
    const after = openWorld
      // Identity conversion may add aliases; retained aliases must still resolve to their original owners.
      ? `SELECT ${list} FROM main.${quote(table.name)} WHERE alias IN (SELECT alias FROM source.${quote(table.name)})`
      : `SELECT ${list} FROM main.${quote(table.name)}${retainedOnly("")}`;
    const result = database.prepare(`
      WITH ${recovery}, before AS (${before}), after AS (${after})
      SELECT (SELECT count(*) FROM (SELECT * FROM before EXCEPT SELECT * FROM after)) AS missing,
        (SELECT count(*) FROM (SELECT * FROM after EXCEPT SELECT * FROM before)) AS added,
        (SELECT count(*) FROM before) AS beforeCount, (SELECT count(*) FROM after) AS afterCount
    `).get() as { missing: number; added: number; beforeCount: number; afterCount: number };
    assert.deepEqual({ missing: result.missing, added: openWorld ? 0 : result.added }, { missing: 0, added: 0 },
      `${table.name} must retain every current relational fact`);
    if (!openWorld) assert.equal(result.afterCount, result.beforeCount, `${table.name} must retain its row count`);
    verified += 1;
  }
  return verified;
}

/**
 * Migrate a copy of the checkpoint through the database owner's own initialization, and nothing else: startup jobs
 * such as retention, discovery, stats repair, usage imports and command reaping legitimately rewrite rows afterwards.
 */
async function verifyMigrationFidelity(checkpoint: string, version: number) {
  const workRoot = await fs.mkdtemp(path.join(path.dirname(checkpoint), "migration-fidelity-"));
  try {
    const migratedPath = path.join(workRoot, "migrated.sqlite3");
    await fs.copyFile(checkpoint, migratedPath);
    const owner = new WorkbenchDatabaseController({ databasePath: migratedPath });
    try { await owner.start(); } finally { await owner.close(); }

    const effects = RELEASE_DATA_EFFECTS.filter(effect => version < effect.version);
    let sourcePath = checkpoint;
    if (effects.length) {
      sourcePath = path.join(workRoot, "expected.sqlite3");
      await fs.copyFile(checkpoint, sourcePath);
      const expected = new Database(sourcePath, { fileMustExist: true });
      try { expected.transaction(() => { for (const effect of effects) effect.apply(expected); })(); }
      finally { expected.close(); }
    }
    const database = new Database(migratedPath, { fileMustExist: true });
    try {
      // Read-only scans: mappings avoid copying every page into SQLite's cache.
      database.pragma("mmap_size = 2147483648");
      database.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
      database.pragma("source.mmap_size = 2147483648");
      try { return compareRetainedFacts(database); }
      finally { database.exec("DETACH DATABASE source"); }
    } finally { database.close(); }
  } finally {
    await fs.rm(workRoot, { force: true, recursive: true });
  }
}

/**
 * Run after the real daemon upgraded and used the capture. Migration fidelity is proved on an init-only copy of the
 * pre-upgrade checkpoint; the daemon-run database must still be current, referentially valid and structurally sound.
 * No full integrity_check: index/table drift would mean a SQLite or disk fault, not a migration defect.
 */
export async function verifyThreadStateMigrationSource(source: Awaited<ReturnType<typeof captureThreadStateMigrationSource>>) {
  if (source.version < workbenchDatabaseSchema.currentVersion) {
    assert.ok(await findPreUpgradeCheckpoint(source.databasePath, source.version),
      "An upgraded database must leave its verified pre-upgrade checkpoint");
  }
  const verified = await verifyMigrationFidelity(source.checkpointPath, source.version);
  const database = new Database(source.databasePath, { fileMustExist: true });
  try {
    assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
    assert.deepEqual(database.pragma("foreign_key_check"), [], "Retained database foreign keys must remain valid");
    assert.deepEqual(database.pragma("quick_check"), [{ quick_check: "ok" }], "Retained database quick_check must pass");
  } finally { database.close(); }
  console.log(`database schema ${source.version} -> ${workbenchDatabaseSchema.currentVersion}; ${verified} relational tables verified against pristine pre-startup facts`);
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
