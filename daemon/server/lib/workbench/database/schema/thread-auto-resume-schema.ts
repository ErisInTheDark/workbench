/*
 * Exports:
 * - threadAutoResumeSettings: the daemon's edited auto resume settings; no row uses the defaults.
 * - threadAutoResumeSchemaHistory: settings storage history.
 */
import { booleanInteger, check, defineTable, enumText, integer, sql } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const settings = defineTable("workbench_thread_auto_resume", {
  id: enumText("global").primaryKey(),
  enabled: booleanInteger().notNull(),
  idle_minutes: integer().notNull(),
}, table => ({
  constraints: [check(sql`${table.idle_minutes} BETWEEN 10 AND 120 AND ${table.idle_minutes} % 10 = 0`)],
}));
const history = defineTableHistory({
  current: settings,
  versions: [tableVersion({ schemaVersion: releases.threadAutoResume.version, table: settings, migration: createTable(settings) })],
});

export const threadAutoResumeSettings = history.current;
export const threadAutoResumeSchemaHistory = defineSubsystemHistory([history]);
