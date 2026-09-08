/*
 * Keywords: thread, title, history, sqlite, authority.
 * Exports:
 * - threadTitleHistoryTables: authoritative distinct thread titles, separate from document projections.
 * - threadTitleHistorySchemaHistory: additive title-history table installation.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { defineTable, enumText, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";

const titles = defineTable("workbench_thread_title_history", {
  project_id: text().notNull().references("workbench_thread_state_projects", "project_id", { onDelete: "CASCADE" }),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  thread_id: text().notNull(),
  title: text().notNull(),
  used_at: integer().notNull().nonNegative(),
}, (table) => ({ constraints: [primaryKey([table.project_id, table.harness_id, table.thread_id, table.title])] }));
const history = defineTableHistory({
  versions: [tableVersion({ schemaVersion: databaseReleases.threadTitleHistory.version, table: titles, migration: createTable(titles) })],
  current: titles,
});

export const threadTitleHistoryTables = { titles: history.current };
export const threadTitleHistorySchemaHistory = defineSubsystemHistory([history]);
