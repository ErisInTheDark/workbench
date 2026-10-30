/*
 * Exports:
 * - networkGrantSchemaHistory: a target daemon's inbound agent network grants, and each requesting thread's approval history.
 */
import { check, defineTable, enumText, index, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// Callers live on other daemons, so grants name them by daemon and thread id rather than by foreign key.
// Grants are deduplicated by the store: SQLite unique constraints treat the nullable targets as always distinct.
const inboundGrants = defineTable("workbench_network_inbound_grants", {
  id: text().primaryKey(),
  kind: enumText("thread", "message", "folder", "feedback").notNull(),
  caller_daemon_id: text().notNull(),
  caller_thread_id: text().notNull(),
  caller_hostname: text().notNull(),
  caller_title: text().notNull(),
  target_thread_id: text(),
  target_project_id: text(),
  target_label: text().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [
    check(sql`(${table.kind} IN (${literal("thread")}, ${literal("message")})) = (${table.target_thread_id} IS NOT NULL)`),
    check(sql`${table.kind} <> ${literal("folder")} OR ${table.target_project_id} IS NOT NULL`),
  ],
  indexes: [index("workbench_network_inbound_grants_caller_idx", [table.caller_daemon_id, table.caller_thread_id])],
}));

const history = defineTable("workbench_thread_network_history", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  target_daemon_id: text().notNull(),
  /** The approved `NetworkTarget` as JSON; conformed on read. */
  target: text().notNull(),
  approved_at: integer().notNull().nonNegative(),
  revoked_at: integer().nonNegative(),
}, table => ({ indexes: [index("workbench_thread_network_history_thread_idx", [table.thread_id, table.approved_at])] }));

export const networkGrantSchemaHistory = defineSubsystemHistory([
  defineTableHistory({
    current: inboundGrants,
    versions: [tableVersion({ schemaVersion: releases.crossDaemonNetworking.version, table: inboundGrants, migration: createTable(inboundGrants) })],
  }),
  defineTableHistory({
    current: history,
    versions: [tableVersion({ schemaVersion: releases.crossDaemonNetworking.version, table: history, migration: createTable(history) })],
  }),
]);
