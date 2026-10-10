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
const DAY_MS = 86_400_000;

function applyRetentionOracle(databasePath: string, retentionRunAt: number) {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      database.exec(`
        CREATE TEMP TABLE oracle_result_items(item_id INTEGER PRIMARY KEY);
        INSERT INTO oracle_result_items
        SELECT item.id
        FROM thread_items item
        LEFT JOIN thread_operation_process_sources process ON process.item_id = item.id
        LEFT JOIN thread_operation_callable_tool_sources callable ON callable.item_id = item.id
        LEFT JOIN thread_callable_mcp_results mcp ON mcp.item_id = item.id
        LEFT JOIN thread_callable_dynamic_content dynamic ON dynamic.item_id = item.id
        LEFT JOIN thread_item_tool_outputs output ON output.item_id = item.id
        WHERE item.created_at < ${retentionRunAt - DAY_MS} AND (
          (process.output_text IS NOT NULL AND process.state NOT IN ('queued', 'inProgress'))
          OR (mcp.item_id IS NOT NULL AND callable.state IN ('completed', 'failed'))
          OR (dynamic.item_id IS NOT NULL AND callable.state IN ('completed', 'failed'))
          OR output.item_id IS NOT NULL
        );

        CREATE TEMP TABLE oracle_expired_turns(turn_id TEXT PRIMARY KEY);
        INSERT INTO oracle_expired_turns
        SELECT turn.id FROM thread_turns turn
        JOIN workbench_thread_retention retention ON retention.thread_id = turn.thread_id
        WHERE retention.settled_at < ${retentionRunAt - 3 * DAY_MS};

        CREATE TABLE thread_item_payload_retention(
          item_id INTEGER PRIMARY KEY,
          expired_at INTEGER NOT NULL
        );
        INSERT INTO thread_item_payload_retention
        SELECT item_id, ${retentionRunAt} FROM oracle_result_items;
        CREATE TABLE thread_turn_payload_retention(
          turn_id TEXT PRIMARY KEY,
          expired_at INTEGER NOT NULL
        );
        INSERT INTO thread_turn_payload_retention
        SELECT turn_id, ${retentionRunAt} FROM oracle_expired_turns;

        CREATE TABLE thread_tool_daily_aggregates(
          project_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          day INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          call_count INTEGER NOT NULL,
          failure_count INTEGER NOT NULL,
          PRIMARY KEY(project_id, thread_id, day, tool_name)
        );
        INSERT INTO thread_tool_daily_aggregates
        SELECT thread.project_id, item.thread_id, CAST(item.created_at / ${DAY_MS} AS INTEGER),
          callable.tool_name, COUNT(*), SUM(callable.state = 'failed')
        FROM thread_items item
        JOIN workbench_threads thread ON thread.id = item.thread_id
        JOIN thread_operation_callable_tool_sources callable ON callable.item_id = item.id
        WHERE callable.server_name IN ('wb', 'wbex')
          AND callable.state IN ('completed', 'failed')
          AND (
            item.id IN (SELECT item_id FROM oracle_result_items)
            OR item.turn_id IN (SELECT turn_id FROM oracle_expired_turns)
          )
        GROUP BY thread.project_id, item.thread_id, CAST(item.created_at / ${DAY_MS} AS INTEGER), callable.tool_name;

        UPDATE thread_operation_process_sources SET output_text = NULL
        WHERE item_id IN (SELECT item_id FROM oracle_result_items);
        DELETE FROM thread_callable_mcp_results
        WHERE item_id IN (SELECT item_id FROM oracle_result_items);
        DELETE FROM thread_callable_dynamic_content
        WHERE item_id IN (SELECT item_id FROM oracle_result_items);
        DELETE FROM thread_tool_output_parts
        WHERE item_id IN (SELECT item_id FROM oracle_result_items);
        UPDATE thread_item_tool_outputs SET body_kind = 'text', body_text = ''
        WHERE item_id IN (SELECT item_id FROM oracle_result_items);
        DELETE FROM transcript_native_records
        WHERE turn_id IN (SELECT turn_id FROM oracle_expired_turns);
        DELETE FROM thread_items
        WHERE turn_id IN (SELECT turn_id FROM oracle_expired_turns);

        CREATE TEMP TABLE oracle_orphan_assets(digest TEXT PRIMARY KEY);
        INSERT INTO oracle_orphan_assets
        SELECT asset.digest FROM transcript_assets asset
        WHERE asset.created_at < ${retentionRunAt - 3_600_000}
          AND NOT EXISTS (SELECT 1 FROM transcript_asset_refs ref WHERE ref.asset_digest = asset.digest)
          AND NOT EXISTS (SELECT 1 FROM thread_browse_entries entry WHERE entry.asset_digest = asset.digest)
          AND NOT EXISTS (
            SELECT 1 FROM transcript_asset_addresses address
            WHERE address.digest = asset.digest AND (
              EXISTS (SELECT 1 FROM thread_user_message_parts part
                JOIN thread_items item ON item.id = part.item_id
                WHERE item.thread_id = address.thread_id
                  AND instr(COALESCE(part.url, '') || COALESCE(part.text, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_held_steer_parts part
                JOIN thread_held_steers steer ON steer.id = part.steer_id
                WHERE steer.thread_id = address.thread_id
                  AND instr(COALESCE(part.url, '') || COALESCE(part.text, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_tool_output_parts part
                JOIN thread_items item ON item.id = part.item_id
                WHERE item.thread_id = address.thread_id
                  AND instr(COALESCE(part.image_url, '') || COALESCE(part.text, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_callable_dynamic_content content
                JOIN thread_items item ON item.id = content.item_id
                WHERE item.thread_id = address.thread_id
                  AND instr(COALESCE(content.url, '') || COALESCE(content.text, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_callable_mcp_result_content content
                JOIN thread_items item ON item.id = content.item_id
                WHERE item.thread_id = address.thread_id
                  AND instr(COALESCE(content.text, '') || COALESCE(content.opaque_json, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_callable_mcp_results result
                JOIN thread_items item ON item.id = result.item_id
                WHERE item.thread_id = address.thread_id
                  AND instr(COALESCE(result.structured_content_json, '') || COALESCE(result.meta_json, ''), address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM thread_item_unknown body
                JOIN thread_items item ON item.id = body.item_id
                WHERE item.thread_id = address.thread_id AND instr(body.safe_json, address.asset_name) > 0)
              OR EXISTS (SELECT 1 FROM transcript_native_records record
                WHERE record.thread_id = address.thread_id AND instr(record.payload_json, address.asset_name) > 0)
            )
          );
        DELETE FROM transcript_asset_addresses
        WHERE digest IN (SELECT digest FROM oracle_orphan_assets);
        DELETE FROM transcript_assets
        WHERE digest IN (SELECT digest FROM oracle_orphan_assets);
        DELETE FROM workbench_git_arc_proposal_diffs
        WHERE last_accessed_at < ${retentionRunAt - DAY_MS};
      `);
    })();
    assert.deepEqual(database.pragma("foreign_key_check"), [], "The independent retention oracle must preserve foreign keys");
  } finally { database.close(); }
}

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
  const oraclePath = `${source.databasePath}.retention-oracle`;
  if (checkpoint) {
    const retained = new Database(source.databasePath, { readonly: true, fileMustExist: true });
    let retentionRunAt: number;
    try {
      const rows = retained.prepare(`
        SELECT DISTINCT expired_at FROM (
          SELECT expired_at FROM thread_item_payload_retention
          UNION ALL SELECT expired_at FROM thread_turn_payload_retention
        ) ORDER BY expired_at
      `).all() as Array<{ expired_at: number }>;
      assert.ok(rows.length, "Retained startup must leave an observable retention epoch");
      // Retention cutoffs only advance, so the latest epoch subsumes every earlier startup run.
      retentionRunAt = rows.at(-1)!.expired_at;
    } finally { retained.close(); }
    await fs.copyFile(checkpoint, oraclePath);
    applyRetentionOracle(oraclePath, retentionRunAt);
  }
  const database = new Database(source.databasePath, { fileMustExist: true });
  try {
    // Read-only scans: mappings avoid copying every page into SQLite's cache.
    database.pragma("mmap_size = 2147483648");
    assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
    let verified = 0;
    if (checkpoint) {
      database.prepare("ATTACH DATABASE ? AS source").run(oraclePath);
      database.pragma("source.mmap_size = 2147483648");
      try {
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
    assert.deepEqual(database.pragma("foreign_key_check"), [], "Retained database foreign keys must remain valid");
    assert.deepEqual(database.pragma("quick_check"), [{ quick_check: "ok" }], "Retained database quick_check must pass");
    assert.ok((await fs.stat(source.databasePath)).size < 512 * 1024 * 1024,
      "Retained database must compact below 0.5 GiB");
    console.log(`database schema ${source.version} -> ${workbenchDatabaseSchema.currentVersion}; ${checkpoint
      ? `${verified} relational tables verified against the independent retention oracle`
      : "no data-changing startup steps, nothing to compare"}`);
  } finally {
    database.close();
    if (checkpoint) await fs.rm(oraclePath, { force: true });
  }
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
