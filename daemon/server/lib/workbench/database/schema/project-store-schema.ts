/*
 * Exports:
 * - projectStoreSchemaHistory: encrypted per-project store entries.
 */
import { blob, defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const entries = defineTable("workbench_project_store_entries", {
  project_id: text().notNull().references("workbench_projects", "id", { onDelete: "CASCADE" }),
  key: text().notNull(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull(),
}, table => ({ constraints: [primaryKey([table.project_id, table.key])] }));

export const projectStoreSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: entries,
  versions: [tableVersion({ schemaVersion: releases.projectStore.version, table: entries, migration: createTable(entries) })],
})]);
