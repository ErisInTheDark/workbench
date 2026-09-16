/*
 * Exports:
 * - gitArcProposalDiffs: immutable proposal diff cache rows.
 * - gitArcProposalDiffPaths: ordered cache identity paths.
 * - gitArcProposalDiffChanges: ordered typed file changes.
 * - gitArcProposalDiffTables: current proposal diff cache table inventory.
 * - gitArcProposalDiffSchemaHistory: proposal diff cache schema history.
 */
import { check, defineTable, enumText, integer, literal, primaryKey, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, deleteRows, rebuildTable, tableVersion } from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_git_arc_proposal_diffs", {
  cache_key: text().primaryKey(),
  repository_root: text().notNull(),
  base_tree: text().notNull(),
  target_tree: text().notNull(),
  paths_json: text().notNull(),
  changes_json: text().notNull(),
  byte_size: integer().notNull().nonNegative(),
  last_accessed_at: integer().notNull().nonNegative(),
  format_version: integer().notNull(),
}, table => ({
  constraints: [check(sql`${table.format_version} = ${literal(1)}`)],
}));
const currentTable = defineTable("workbench_git_arc_proposal_diffs", {
  cache_key: text().primaryKey(),
  repository_root: text().notNull(),
  base_tree: text().notNull(),
  target_tree: text().notNull(),
  byte_size: integer().notNull().nonNegative(),
  last_accessed_at: integer().notNull().nonNegative(),
  format_version: integer().notNull(),
}, table => ({
  constraints: [check(sql`${table.format_version} = ${literal(1)}`)],
}));
const history = defineTableHistory({
  current: currentTable,
  versions: [tableVersion({
    migration: createTable(table),
    schemaVersion: databaseReleases.gitArcProposalDiffCache.version,
    table,
  }), tableVersion({
    schemaVersion: databaseReleases.relationalProposalDiffs.version,
    table: currentTable,
    migration: [
      deleteRows(table.name, sql`${literal(1)} = ${literal(1)}`),
      rebuildTable({ from: table, to: currentTable }),
    ],
  })],
});

const pathsTable = defineTable("workbench_git_arc_proposal_diff_paths", {
  cache_key: text().notNull().references(currentTable.name, "cache_key", { onDelete: "CASCADE" }),
  position: integer().notNull().nonNegative(),
  path: text().notNull(),
}, table => ({ constraints: [primaryKey([table.cache_key, table.position])] }));
const pathsHistory = defineTableHistory({
  current: pathsTable,
  versions: [tableVersion({
    schemaVersion: databaseReleases.relationalProposalDiffs.version,
    table: pathsTable,
    migration: createTable(pathsTable),
  })],
});
const changesTable = defineTable("workbench_git_arc_proposal_diff_changes", {
  cache_key: text().notNull().references(currentTable.name, "cache_key", { onDelete: "CASCADE" }),
  position: integer().notNull().nonNegative(),
  path: text().notNull(),
  kind: enumText("add", "delete", "update").notNull(),
  move_path: text(),
  additions: integer().notNull().nonNegative(),
  deletions: integer().notNull().nonNegative(),
  diff: text().notNull(),
}, table => ({
  constraints: [
    primaryKey([table.cache_key, table.position]),
    check(sql`${table.kind} = ${literal("update")} OR ${table.move_path} IS NULL`),
  ],
}));
const changesHistory = defineTableHistory({
  current: changesTable,
  versions: [tableVersion({
    schemaVersion: databaseReleases.relationalProposalDiffs.version,
    table: changesTable,
    migration: createTable(changesTable),
  })],
});

export const gitArcProposalDiffs = history.current;
export const gitArcProposalDiffPaths = pathsHistory.current;
export const gitArcProposalDiffChanges = changesHistory.current;
export const gitArcProposalDiffTables = Object.freeze({ gitArcProposalDiffs, gitArcProposalDiffPaths, gitArcProposalDiffChanges });
export const gitArcProposalDiffSchemaHistory = defineSubsystemHistory([history, pathsHistory, changesHistory]);
