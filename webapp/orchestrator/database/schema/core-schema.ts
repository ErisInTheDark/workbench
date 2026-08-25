/*
 * workbenchHarnesses: current harness identity table. Keywords: database, schema, harness.
 * workbenchThreads: current Workbench thread table. Keywords: database, schema, thread.
 * workbenchPendingImportThreads: current temporary native import mapping table. Keywords: database, schema, import.
 * threadTurns: current harness turn table. Keywords: database, schema, turn.
 * workbenchThreadLifecycle: current thread lifecycle table. Keywords: database, schema, lifecycle.
 * coreTables: current core table inventory. Keywords: database, schema, core.
 * CoreSchemaRows: selected row types for current core tables. Keywords: database, schema, types.
 * coreSchemaHistory: private core table histories. Keywords: database, schema, history.
 */
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  foreignKey,
  index,
  integer,
  literal,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "./schema-definition.ts";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "./schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table, migration: createTable(table) })],
    current: table,
  });
}

const workbenchHarnessesV1 = defineTable("workbench_harnesses", {
  id: text().primaryKey(),
});
const workbenchHarnessesHistory = initialHistory(workbenchHarnessesV1);
export const workbenchHarnesses = workbenchHarnessesHistory.current;

const workbenchThreadsV1 = defineTable("workbench_threads", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  project_root: text().notNull(),
  title: text().notNull(),
  archived: booleanInteger().notNull().default(0),
  pinned: booleanInteger().notNull().default(0),
  snoozed: booleanInteger().notNull().default(0),
  transcript_content_version: integer().notNull().nonNegative(),
  next_turn_index: integer().notNull().default(0).nonNegative(),
  next_item_index: integer().notNull().default(0).nonNegative(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  activity_at: integer().notNull(),
}, (table) => ({
  constraints: [
    check(sql`${table.archived} = ${literal(0)} OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})`),
  ],
}));
const workbenchThreadsHistory = initialHistory(workbenchThreadsV1);
export const workbenchThreads = workbenchThreadsHistory.current;

const workbenchPendingImportThreadsV1 = defineTable("workbench_pending_import_threads", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  harness_id: text().notNull().references("workbench_harnesses", "id"),
  native_location: text().notNull(),
  native_thread_id: text().notNull(),
  discovered_at: integer().notNull(),
  last_seen_at: integer().notNull(),
}, (table) => ({
  constraints: [unique([table.harness_id, table.native_location, table.native_thread_id])],
}));
const workbenchPendingImportThreadsHistory = initialHistory(workbenchPendingImportThreadsV1);
export const workbenchPendingImportThreads = workbenchPendingImportThreadsHistory.current;

const threadTurnsV1 = defineTable("thread_turns", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  turn_index: integer().notNull().nonNegative(),
  harness_id: text().notNull().references("workbench_harnesses", "id"),
  native_location: text().notNull(),
  native_thread_id: text().notNull(),
  native_turn_id: text(),
  state: enumText("admitted", "inProgress", "completed", "interrupted", "failed").notNull(),
  created_at: integer().notNull(),
  started_at: integer(),
  ended_at: integer(),
  duration_ms: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.thread_id, table.turn_index]),
    unique([table.id, table.thread_id]),
    unique([table.id, table.thread_id, table.harness_id, table.native_location, table.native_thread_id]),
    check(sql`
      (${table.state} = ${literal("admitted")} AND ${table.started_at} IS NULL AND ${table.ended_at} IS NULL)
      OR (${table.state} = ${literal("inProgress")} AND ${table.started_at} IS NOT NULL AND ${table.ended_at} IS NULL)
      OR (${table.state} IN (${literal("completed")}, ${literal("interrupted")}, ${literal("failed")}) AND ${table.started_at} IS NOT NULL AND ${table.ended_at} IS NOT NULL)
    `),
  ],
  indexes: [
    index("thread_turns_native_thread_idx", [table.harness_id, table.native_location, table.native_thread_id]),
    index("thread_turns_native_turn_idx", [table.harness_id, table.native_location, table.native_thread_id, table.native_turn_id], {
      unique: true,
      where: sql`${table.native_turn_id} IS NOT NULL`,
    }),
  ],
}));
const threadTurnsHistory = initialHistory(threadTurnsV1);
export const threadTurns = threadTurnsHistory.current;

const workbenchThreadLifecycleV1 = defineTable("workbench_thread_lifecycle", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  lifecycle_kind: enumText("working", "needsAttention", "completed", "stopped").notNull(),
  reason: enumText(
    "acceptedIntent",
    "pendingInput",
    "noActiveTurn",
    "agentCompleted",
    "userCompleted",
    "providerInactive",
    "providerInterrupted",
    "userMarkedStopped",
  ).notNull(),
  settled: booleanInteger().notNull(),
  turn_id: text(),
  request_key: text(),
  agent_status: enumText("working", "completed", "blocked"),
  updated_at: integer().notNull(),
}, (table) => ({
  constraints: [
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns",
      columns: ["id", "thread_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadLifecycleHistory = initialHistory(workbenchThreadLifecycleV1);
export const workbenchThreadLifecycle = workbenchThreadLifecycleHistory.current;

export const coreTables = Object.freeze({
  workbenchHarnesses,
  workbenchThreads,
  workbenchPendingImportThreads,
  threadTurns,
  workbenchThreadLifecycle,
});

export type CoreSchemaRows = {
  [Name in keyof typeof coreTables]: SelectRow<(typeof coreTables)[Name]>;
};

export const coreSchemaHistory = defineSubsystemHistory([
  workbenchHarnessesHistory,
  workbenchThreadsHistory,
  workbenchPendingImportThreadsHistory,
  threadTurnsHistory,
  workbenchThreadLifecycleHistory,
]);
