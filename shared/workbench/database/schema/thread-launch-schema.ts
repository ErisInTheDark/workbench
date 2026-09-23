/*
 * Exports:
 * - threadLaunchTables/ThreadLaunchRows: durable launch intent and native acceptance progress.
 * - threadLaunchSchemaHistory: install launch storage after stable concrete project ownership.
 */
import { defineTable, enumText, integer, text, type SelectRow } from "../../../database/schema/schema-definition.ts";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "../../../database/schema/schema-history.ts";
import databaseReleases from "./releases.ts";

const launches = defineTable("workbench_thread_launches", {
  id: text().primaryKey(),
  project_id: text().notNull().references("workbench_projects", "id"),
  request_hash: text().notNull(),
  request_json: text().notNull(),
  phase: enumText("prepared", "creating", "created", "sending", "accepted", "failed", "unknown").notNull(),
  thread_id: text().references("workbench_threads", "id"),
  turn_id: text(),
  reason: text(),
  updated_at: integer().notNull().nonNegative(),
});
const history = defineTableHistory({
  current: launches,
  versions: [tableVersion({
    schemaVersion: databaseReleases.threadLaunches.version,
    table: launches,
    migration: createTable(launches),
  })],
});
export const threadLaunchTables = Object.freeze({ launches: history.current });
export type ThreadLaunchRows = { launches: SelectRow<typeof history.current> };
export const threadLaunchSchemaHistory = defineSubsystemHistory([history]);
