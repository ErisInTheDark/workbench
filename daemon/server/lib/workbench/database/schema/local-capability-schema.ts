/*
 * Exports:
 * - localCapabilities: local server capability singleton.
 * - localCapabilitySchemaHistory: capability storage history.
 */
import { booleanInteger, defineTable, enumText } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_local_capabilities", {
  id: enumText("global").primaryKey(),
  browse_raw_commands_enabled: booleanInteger().notNull(),
});
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.externalCatalogues.version, table, migration: createTable(table) })],
});
export const localCapabilities = history.current;
export const localCapabilitySchemaHistory = defineSubsystemHistory([history]);
