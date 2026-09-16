/*
 * Exports:
 * - threadGitSelectionSchemaHistory: current selections and atomically claimed commit batches.
 */
import { defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const selected = defineTable("workbench_thread_git_selections", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  worktree_root: text().notNull(),
  path: text().notNull(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.worktree_root, table.path])] }));
const batches = defineTable("workbench_thread_git_batches", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  worktree_root: text().notNull(),
  claimed_at: integer().notNull(),
});
const batchPaths = defineTable("workbench_thread_git_batch_paths", {
  batch_id: text().notNull().references("workbench_thread_git_batches", "id", { onDelete: "CASCADE" }),
  path: text().notNull(),
}, table => ({ constraints: [primaryKey([table.batch_id, table.path])] }));

export const threadGitSelectionSchemaHistory = defineSubsystemHistory([selected, batches, batchPaths].map(table => defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.threadGitSelections.version, table, migration: createTable(table) })],
})));
