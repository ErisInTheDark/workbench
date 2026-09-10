/*
 * Exports:
 * - workbenchHarnesses: current harness identity table.
 * - workbenchThreads: current Workbench thread table.
 * - workbenchPendingImportThreads: current temporary native import mapping table.
 * - threadTurns: current harness turn table.
 * - threadTurnMaterializations: current complete transcript-body marker for one turn.
 * - workbenchThreadLifecycle: current thread lifecycle table.
 * - coreTables: current core table inventory.
 * - CoreSchemaRows: selected row types for current core tables.
 * - coreSchemaHistory: private core table histories.
 * - defineThreadDomainCoreSchema: indexed project identity and constrained lifecycle for relational thread-state cutover.
 */
import databaseReleases from "./releases.ts";
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  index,
  integer,
  literal,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "../../../database/schema/schema-definition.ts";
import {
  addColumns,
  createIndexes,
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  rebuildTable,
  tableVersion,
} from "../../../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table, migration: createTable(table) })],
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
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  activity_at: integer().notNull(),
}, (table) => ({
  constraints: [
    check(sql`${table.archived} = ${literal(0)} OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})`),
  ],
}));
const workbenchThreadsV2 = evolveTable(workbenchThreadsV1, {
  add: { identity_origin: enumText("legacy", "workbench").notNull().default("legacy") },
});
const workbenchThreadsHistory = defineTableHistory({
  current: workbenchThreadsV2,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: workbenchThreadsV1, migration: createTable(workbenchThreadsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.threadIdentityOrigin.version,
      table: workbenchThreadsV2,
      migration: addColumns({ from: workbenchThreadsV1, to: workbenchThreadsV2, columns: ["identity_origin"] }),
    }),
  ],
});
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
const workbenchPendingImportThreadsV2 = evolveTable(workbenchPendingImportThreadsV1, {
  extras: (table) => ({
    constraints: [unique([table.harness_id, table.native_location, table.native_thread_id])],
    indexes: [
      index("workbench_pending_import_threads_native_reference_idx", [
        table.native_thread_id, table.harness_id, table.native_location, table.thread_id,
      ]),
    ],
  }),
});
const workbenchPendingImportThreadsHistory = defineTableHistory({
  current: workbenchPendingImportThreadsV2,
  versions: [
    tableVersion({
      schemaVersion: databaseReleases.initialTranscript.version,
      table: workbenchPendingImportThreadsV1,
      migration: createTable(workbenchPendingImportThreadsV1),
    }),
    tableVersion({
      schemaVersion: databaseReleases.nativeIdentityLookupIndexes.version,
      table: workbenchPendingImportThreadsV2,
      migration: createIndexes({
        from: workbenchPendingImportThreadsV1, to: workbenchPendingImportThreadsV2,
        names: ["workbench_pending_import_threads_native_reference_idx"],
      }),
    }),
  ],
});
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
  ],
  indexes: [
    index("thread_turns_native_thread_idx", [table.harness_id, table.native_location, table.native_thread_id]),
    index("thread_turns_native_turn_idx", [table.harness_id, table.native_location, table.native_thread_id, table.native_turn_id], {
      unique: true,
      where: sql`${table.native_turn_id} IS NOT NULL`,
    }),
  ],
}));
const threadTurnsV2 = evolveTable(threadTurnsV1, {
  add: { identity_origin: enumText("legacy", "workbench").notNull().default("legacy") },
});
const threadTurnsV3 = evolveTable(threadTurnsV2, {
  extras: (table) => ({
    constraints: [
      unique([table.thread_id, table.turn_index]),
      unique([table.id, table.thread_id]),
      unique([table.id, table.thread_id, table.harness_id, table.native_location, table.native_thread_id]),
    ],
    indexes: [
      index("thread_turns_native_thread_idx", [table.harness_id, table.native_location, table.native_thread_id]),
      index("thread_turns_native_turn_idx", [table.harness_id, table.native_location, table.native_thread_id, table.native_turn_id], {
        unique: true,
        where: sql`${table.native_turn_id} IS NOT NULL`,
      }),
      index("thread_turns_native_reference_idx", [
        table.native_thread_id, table.harness_id, table.native_turn_id, table.native_location, table.thread_id,
      ]),
    ],
  }),
});
const threadTurnsHistory = defineTableHistory({
  current: threadTurnsV3,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadTurnsV1, migration: createTable(threadTurnsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.transcriptIdentity.version,
      table: threadTurnsV2,
      migration: addColumns({ from: threadTurnsV1, to: threadTurnsV2, columns: ["identity_origin"] }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.nativeIdentityLookupIndexes.version,
      table: threadTurnsV3,
      migration: createIndexes({
        from: threadTurnsV2, to: threadTurnsV3, names: ["thread_turns_native_reference_idx"],
      }),
    }),
  ],
});
export const threadTurns = threadTurnsHistory.current;

const threadTurnMaterializationsV1 = defineTable("thread_turn_materializations", {
  turn_id: text().primaryKey(),
  thread_id: text().notNull(),
  materialized_at: integer().notNull(),
}, (table) => ({
  constraints: [
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns",
      columns: ["id", "thread_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadTurnMaterializationsHistory = initialHistory(threadTurnMaterializationsV1);
export const threadTurnMaterializations = threadTurnMaterializationsHistory.current;

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

const legacyCoreTables = Object.freeze({
  workbenchHarnesses,
  workbenchThreads,
  workbenchPendingImportThreads,
  threadTurns,
  threadTurnMaterializations,
  workbenchThreadLifecycle,
});

export function defineThreadDomainCoreSchema(schemaVersion: number) {
  const indexedThreads = evolveTable(workbenchThreadsV2, {
    extras: (table) => ({
      constraints: [
        check(sql`${table.archived} = ${literal(0)} OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})`),
      ],
      indexes: [index("workbench_threads_project_activity_idx", [table.project_id, table.activity_at, table.id])],
    }),
  });
  const indexedThreadHistory = defineTableHistory({
    current: indexedThreads,
    versions: [
      ...workbenchThreadsHistory.versions,
      tableVersion({
        schemaVersion, table: indexedThreads,
        migration: createIndexes({
          from: workbenchThreadsV2, to: indexedThreads, names: ["workbench_threads_project_activity_idx"],
        }),
      }),
    ],
  });
  const lifecycle = defineTable("workbench_thread_lifecycle", {
    thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
    lifecycle_kind: enumText("working", "needsAttention", "completed", "stopped").notNull(),
    reason: enumText(
      "acceptedIntent", "pendingInput", "noActiveTurn", "agentBlocked", "agentCompleted",
      "userCompleted", "providerInactive", "providerInterrupted", "userMarkedStopped",
    ).notNull(),
    settled: booleanInteger().notNull(),
    turn_id: text(),
    request_key: text(),
    agent_status: enumText("working", "completed", "blocked"),
    updated_at: integer().notNull(),
  }, (table) => ({
    constraints: [
      foreignKey([table.turn_id, table.thread_id], {
        table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
      }),
      check(sql`
        (${table.lifecycle_kind} = ${literal("working")} AND ${table.reason} = ${literal("acceptedIntent")}
          AND ${table.settled} = ${literal(0)} AND ${table.request_key} IS NULL AND ${table.agent_status} IS ${literal("working")})
        OR (${table.lifecycle_kind} = ${literal("needsAttention")} AND ${table.settled} = ${literal(0)} AND (
          (${table.reason} = ${literal("noActiveTurn")} AND ${table.turn_id} IS NULL AND ${table.request_key} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.reason} = ${literal("pendingInput")} AND ${table.turn_id} IS NOT NULL AND ${table.request_key} IS NOT NULL AND ${table.agent_status} IS NULL)
          OR (${table.reason} = ${literal("agentBlocked")} AND ${table.turn_id} IS NOT NULL AND ${table.request_key} IS NULL AND ${table.agent_status} IS ${literal("blocked")})
        ))
        OR (${table.lifecycle_kind} = ${literal("completed")} AND ${table.request_key} IS NULL AND (
          (${table.reason} = ${literal("agentCompleted")} AND ${table.turn_id} IS NOT NULL AND ${table.agent_status} IS ${literal("completed")})
          OR (${table.reason} = ${literal("providerInactive")} AND ${table.turn_id} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.reason} = ${literal("userCompleted")} AND (
            (${table.turn_id} IS NULL AND ${table.agent_status} IS NULL) OR (${table.turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)
          ))
        ))
        OR (${table.lifecycle_kind} = ${literal("stopped")} AND ${table.request_key} IS NULL AND (
          (${table.reason} = ${literal("providerInterrupted")} AND ${table.turn_id} IS NOT NULL AND ${table.agent_status} IS NULL)
          OR (${table.reason} = ${literal("userMarkedStopped")} AND (
            (${table.turn_id} IS NULL AND ${table.agent_status} IS NULL) OR (${table.turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)
          ))
        ))
      `),
    ],
  }));
  const lifecycleHistory = defineTableHistory({
    current: lifecycle,
    versions: [
      ...workbenchThreadLifecycleHistory.versions,
      tableVersion({
        schemaVersion, table: lifecycle, migration: rebuildTable({ from: workbenchThreadLifecycleV1, to: lifecycle }),
      }),
    ],
  });
  return {
    tables: { ...legacyCoreTables, workbenchThreads: indexedThreadHistory.current, workbenchThreadLifecycle: lifecycleHistory.current },
    history: defineSubsystemHistory([
      workbenchHarnessesHistory, indexedThreadHistory, workbenchPendingImportThreadsHistory,
      threadTurnsHistory, threadTurnMaterializationsHistory, lifecycleHistory,
    ]),
  };
}

const currentCore = defineThreadDomainCoreSchema(23);
export const coreTables = Object.freeze(currentCore.tables);
export const coreSchemaHistory = currentCore.history;
export type CoreSchemaRows = {
  [Name in keyof typeof coreTables]: SelectRow<(typeof coreTables)[Name]>;
};
