/*
 * Exports:
 * - threadGoalSchemaHistory: per-thread user-set goal and its undelivered agent notice.
 */
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// A row stays while a goal is set, or while its clear notice is undelivered (objective NULL).
const goals = defineTable("workbench_thread_goals", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  objective: text(),
  pending_notice: text(),
  updated_at: integer().notNull(),
});

export const threadGoalSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: goals,
  versions: [tableVersion({ schemaVersion: releases.threadGoals.version, table: goals, migration: createTable(goals) })],
})]);
