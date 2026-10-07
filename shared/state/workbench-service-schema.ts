/*
 * Exports:
 * - serviceTables: typed durable service facts and shared network tables.
 * - serviceTableInventory: SQLite-name inventory for checked statements.
 * - serviceSchema: versioned service database history.
 */
import {
  booleanInteger, defineTable, enumText, integer, text, type TableDefinition,
} from "../database/schema/schema-definition.ts";
import {
  createTable, defineSubsystemHistory, defineTableHistory, defineWorkbenchDatabaseSchema, retireTableHistory, tableVersion,
} from "../database/schema/schema-history.ts";
import { workbenchNetworkHistory, workbenchNetworkTables } from "./workbench-network-state-schema.ts";
import serviceReleases from "./workbench-service-releases.ts";

const metadata = defineTable("service_identity", {
  id: enumText("singleton").primaryKey(),
  daemon_id: text().notNull().unique(),
});
const wake = defineTable("service_wake", {
  id: enumText("singleton").primaryKey(),
  enabled: booleanInteger().notNull(),
});
const intent = defineTable("service_daemon_intent", {
  id: enumText("singleton").primaryKey(),
  session_id: text().notNull(),
});
const failure = defineTable("service_startup_failure", {
  id: enumText("singleton").primaryKey(),
  message: text().notNull(),
});
const imported = defineTable("service_network_import", {
  id: enumText("singleton").primaryKey(),
  source: text().notNull(),
  imported_at: integer().notNull().nonNegative(),
});
function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({ schemaVersion: 1, table, migration: createTable(table) })],
  });
}
const ownHistories = {
  metadata: initialHistory(metadata),
  wake: initialHistory(wake),
  intent: initialHistory(intent),
  imported: initialHistory(imported),
};
// The daemon host retries failed daemons in memory, so durable startup-failure parking is retired.
// Sealed fingerprints follow history order, so the retired table keeps its original position.
const histories = [
  ...workbenchNetworkHistory(1, 1, 1), ownHistories.metadata, ownHistories.wake, ownHistories.intent,
  retireTableHistory(initialHistory(failure), serviceReleases.retireStartupFailure.version), ownHistories.imported,
];
export const serviceSchema = defineWorkbenchDatabaseSchema({ subsystems: [defineSubsystemHistory(histories)] });
export const serviceTables = Object.freeze({
  ...workbenchNetworkTables,
  metadata: ownHistories.metadata.current,
  wake: ownHistories.wake.current,
  intent: ownHistories.intent.current,
  imported: ownHistories.imported.current,
});
export const serviceTableInventory = Object.freeze(Object.fromEntries(
  serviceSchema.currentTables.map(table => [table.name, table]),
));
