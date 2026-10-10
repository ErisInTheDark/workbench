/*
 * Exports:
 * - execRoots: the root process of each sandboxed command a Workbench executor generation is running.
 * - execRootSchemaHistory: its history.
 */
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

/** A row lives while its command runs; rows of a dead executor generation name processes a hard kill left behind. */
const roots = defineTable("workbench_exec_roots", {
  process_id: text().primaryKey(),
  generation: text().notNull(),
  pid: integer().notNull().nonNegative(),
  /** Windows FILETIME ticks as text, so a reused pid is never mistaken for the original. */
  started_at: text().notNull(),
  recorded_at: integer().notNull().nonNegative(),
});

const rootHistory = defineTableHistory({
  current: roots,
  versions: [tableVersion({ schemaVersion: releases.execRoots.version, table: roots, migration: createTable(roots) })],
});

export const execRoots = rootHistory.current;
export const execRootSchemaHistory = defineSubsystemHistory([rootHistory]);
