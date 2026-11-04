/*
 * Exports:
 * - threadAutoCompactProviders: each provider's edited compaction rules; providers without a row use their defaults.
 * - threadAutoCompactSchemaHistory: settings storage history, including the retired daemon-wide singleton.
 */
import { booleanInteger, check, defineTable, enumText, integer, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, retireTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const singleton = defineTable("workbench_thread_auto_compact", {
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
const singletonHistory = defineTableHistory({
  current: singleton,
  versions: [tableVersion({ schemaVersion: releases.threadAutoCompact.version, table: singleton, migration: createTable(singleton) })],
});

const providers = defineTable("workbench_thread_auto_compact_providers", {
  provider: text().primaryKey(),
  enabled: booleanInteger().notNull(),
  idle_token_threshold: integer(),
  idle_minutes: integer(),
  turn_end_token_threshold: integer().notNull(),
}, table => ({
  constraints: [
    check(sql`(${table.idle_token_threshold} IS NULL) = (${table.idle_minutes} IS NULL)`),
    check(sql`${table.idle_token_threshold} IS NULL OR (${table.idle_token_threshold} BETWEEN 25000 AND 1000000 AND ${table.idle_token_threshold} % 25000 = 0)`),
    check(sql`${table.idle_minutes} IS NULL OR (${table.idle_minutes} BETWEEN 10 AND 120 AND ${table.idle_minutes} % 10 = 0)`),
    check(sql`${table.turn_end_token_threshold} BETWEEN 25000 AND 1000000 AND ${table.turn_end_token_threshold} % 25000 = 0`),
    check(sql`${table.idle_token_threshold} IS NULL OR ${table.turn_end_token_threshold} >= ${table.idle_token_threshold}`),
  ],
}));
const providerHistory = defineTableHistory({
  current: providers,
  versions: [tableVersion({ schemaVersion: releases.threadAutoCompactProviders.version, table: providers, migration: createTable(providers) })],
});

export const threadAutoCompactProviders = providerHistory.current;
export const threadAutoCompactSchemaHistory = defineSubsystemHistory([
  retireTableHistory(singletonHistory, releases.threadAutoCompactProviders.version),
  providerHistory,
]);
