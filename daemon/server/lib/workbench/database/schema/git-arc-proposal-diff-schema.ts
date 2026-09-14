/*
 * Exports:
 * - gitArcProposalDiffs: immutable proposal diff cache rows.
 * - gitArcProposalDiffTables: current proposal diff cache table inventory.
 * - gitArcProposalDiffSchemaHistory: proposal diff cache schema history.
 */
import { check, defineTable, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
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
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({
    migration: createTable(table),
    schemaVersion: databaseReleases.gitArcProposalDiffCache.version,
    table,
  })],
});

export const gitArcProposalDiffs = history.current;
export const gitArcProposalDiffTables = Object.freeze({ gitArcProposalDiffs });
export const gitArcProposalDiffSchemaHistory = defineSubsystemHistory([history]);
