/*
 * Exports:
 * - externalStorageImports: scoped receipts preventing replay of rollback inputs.
 * - externalStorageImportSchemaHistory: external import receipt history.
 */
import { defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_external_storage_imports", {
  source_kind: text().notNull(),
  source_scope: text().notNull(),
  imported_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.source_kind, table.source_scope])] }));
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.externalCatalogues.version, table, migration: createTable(table) })],
});
export const externalStorageImports = history.current;
export const externalStorageImportSchemaHistory = defineSubsystemHistory([history]);
