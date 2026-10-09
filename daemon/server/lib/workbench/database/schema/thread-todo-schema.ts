/*
 * Exports:
 * - threadTodoSchemaHistory: follow-up todos recorded on a thread by its agent or user, numbered within their thread.
 */
import { booleanInteger, check, defineTable, index, integer, primaryKey, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const todosV1 = defineTable("workbench_thread_todos", {
  id: integer().primaryKey({ autoincrement: true }),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  text: text().notNull(),
  required: booleanInteger().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [check(sql`length(${table.text}) BETWEEN 1 AND 4000`)],
  indexes: [index("workbench_thread_todos_thread_idx", [table.thread_id, table.id])],
}));

// A todo's id is its serial within its thread (#1, #2…), handed out by the store rather than SQLite.
const todos = defineTable("workbench_thread_todos", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  id: integer().notNull().nonNegative(),
  text: text().notNull(),
  required: booleanInteger().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [check(sql`length(${table.text}) BETWEEN 1 AND 4000`), primaryKey([table.thread_id, table.id])],
}));

export const threadTodoSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: todos,
  versions: [
    tableVersion({ schemaVersion: releases.threadTodos.version, table: todosV1, migration: createTable(todosV1) }),
    // Global row ids are unique, so they remain valid per-thread serials for todos recorded before threads numbered them.
    tableVersion({ schemaVersion: releases.threadTodoNumbers.version, table: todos, migration: rebuildTable({ from: todosV1, to: todos }) }),
  ],
})]);
