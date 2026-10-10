/*
 * Exports:
 * - threadPayloadRetentionTables: current item and turn payload-expiry evidence.
 * - threadPayloadRetentionSchemaHistory: additive payload-retention schema history.
 */
import { defineTable, integer, text, type TableDefinition } from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, tableVersion,
} from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

function install<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({
      schemaVersion: databaseReleases.boundedPayloadRetention.version,
      table,
      migration: createTable(table),
    })],
  });
}

const itemPayloadRetention = install(defineTable("thread_item_payload_retention", {
  item_id: integer().primaryKey().references("thread_items", "id", { onDelete: "CASCADE" }),
  expired_at: integer().notNull().nonNegative(),
}));

const turnPayloadRetention = install(defineTable("thread_turn_payload_retention", {
  turn_id: text().primaryKey().references("thread_turns", "id", { onDelete: "CASCADE" }),
  expired_at: integer().notNull().nonNegative(),
}));

export const threadPayloadRetentionTables = Object.freeze({
  itemPayloadRetention: itemPayloadRetention.current,
  turnPayloadRetention: turnPayloadRetention.current,
});

export const threadPayloadRetentionSchemaHistory = defineSubsystemHistory([
  itemPayloadRetention,
  turnPayloadRetention,
]);
