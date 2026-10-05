/*
 * Exports:
 * - threadAutoCompactSettings: daemon-wide idle compaction singleton.
 * - threadAutoCompactSchemaHistory: additive settings storage history.
 */
import { booleanInteger, check, defineTable, enumText, integer, sql } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_thread_auto_compact", {
  id: enumText("global").primaryKey(),
  enabled: booleanInteger().notNull(),
  token_threshold: integer().notNull(),
  idle_minutes: integer().notNull(),
}, table => ({
  constraints: [
    check(sql`${table.token_threshold} BETWEEN 25000 AND 1000000 AND ${table.token_threshold} % 25000 = 0`),
    check(sql`${table.idle_minutes} BETWEEN 10 AND 120 AND ${table.idle_minutes} % 10 = 0`),
  ],
}));
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.threadAutoCompact.version, table, migration: createTable(table) })],
});
export const threadAutoCompactSettings = history.current;
export const threadAutoCompactSchemaHistory = defineSubsystemHistory([history]);
