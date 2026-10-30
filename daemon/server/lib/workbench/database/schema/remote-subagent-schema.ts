/*
 * Exports:
 * - remoteSubagentSchemaHistory: subagent relationships whose parent and child live on different daemons. The parent's daemon
 *   holds the relationship; the child's daemon holds the child's subagent state and its parent-pushed sibling roster.
 */
import {
  booleanInteger, check, defineTable, enumText, foreignKey, index, integer, primaryKey, sql, text, unique,
} from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// Parent side: an active relationship whose child thread lives on another daemon, so it cannot reference a local thread.
const remoteRelationships = defineTable("workbench_remote_subagent_relationships", {
  relationship_id: text().primaryKey(),
  relationship_kind: enumText("active").notNull(),
  child_daemon_id: text().notNull(),
  child_hostname: text().notNull(),
  child_project_id: text().notNull(),
  thread_id: text().notNull(),
  /** When this daemon last learned the child settled; frees its name for reuse. */
  settled_at: integer().nonNegative(),
}, table => ({
  constraints: [
    unique([table.child_daemon_id, table.thread_id]),
    foreignKey([table.relationship_id, table.relationship_kind], {
      table: "workbench_subagent_relationships", columns: ["id", "relationship_kind"], onDelete: "CASCADE",
    }),
  ],
}));

// Child side: the same facts as a local subagent's state, but its parent thread lives on another daemon.
const remoteChildren = defineTable("workbench_remote_subagent_thread_states", {
  thread_id: text().primaryKey(),
  thread_kind: enumText("subagent").notNull(),
  parent_daemon_id: text().notNull(),
  parent_hostname: text().notNull(),
  parent_thread_id: text().notNull(),
  cwd: text().notNull(),
  name: text().notNull(),
  profile_id: text().notNull(),
  profile_name: text().notNull(),
  direct_subagent_index: integer().notNull().nonNegative(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  pinned: booleanInteger().notNull(),
}, table => ({
  constraints: [
    foreignKey([table.thread_id, table.thread_kind], {
      table: "workbench_thread_states", columns: ["thread_id", "thread_kind"], onDelete: "CASCADE",
    }),
    check(sql`${table.thread_id} <> ${table.parent_thread_id}`),
  ],
  indexes: [index("workbench_remote_subagent_thread_states_parent_idx", [table.parent_daemon_id, table.parent_thread_id])],
}));

// The parent's latest pushed snapshot of a remote child's siblings; stale rosters reject, never admit.
const siblings = defineTable("workbench_remote_subagent_siblings", {
  thread_id: text().notNull().references("workbench_remote_subagent_thread_states", "thread_id", { onDelete: "CASCADE" }),
  sibling_daemon_id: text().notNull(),
  sibling_thread_id: text().notNull(),
  name: text().notNull(),
  name_key: text().notNull(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.sibling_daemon_id, table.sibling_thread_id])] }));

const install = <Table extends Parameters<typeof createTable>[0]>(table: Table) => defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.crossDaemonNetworking.version, table, migration: createTable(table) })],
});

export const remoteSubagentSchemaHistory = defineSubsystemHistory([
  install(remoteRelationships), install(remoteChildren), install(siblings),
]);
