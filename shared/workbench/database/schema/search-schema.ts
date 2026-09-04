/*
 * Exports:
 * - workbenchSearchDocuments: SQLite-backed project, file, setting, and action search projection. Keywords: database, search, projection.
 * - searchTables/SearchSchemaRows/searchSchemaHistory: current search table registry, row types, and migration history. Keywords: database, schema, search.
 */
import {
  check,
  defineTable,
  enumText,
  index,
  integer,
  literal,
  sql,
  text,
  type SelectRow,
} from "../../../database/schema/schema-definition.ts";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "../../../database/schema/schema-history.ts";

export const workbenchSearchDocuments = defineTable("workbench_search_documents", {
  document_key: text().primaryKey(),
  kind: enumText("action", "file", "project", "projectSetting").notNull(),
  project_id: text(),
  title: text().notNull(),
  detail: text().notNull(),
  target: text().notNull(),
  search_text: text().notNull(),
  updated_at: integer().notNull(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.kind} = ${literal("action")} AND ${table.project_id} IS NULL)
      OR (${table.kind} <> ${literal("action")})
    `),
  ],
  indexes: [
    index("workbench_search_documents_kind_project_idx", [table.kind, table.project_id]),
  ],
}));

const workbenchSearchDocumentsHistory = defineTableHistory({
  current: workbenchSearchDocuments,
  versions: [tableVersion({
    migration: createTable(workbenchSearchDocuments),
    schemaVersion: 6,
    table: workbenchSearchDocuments,
  })],
});

export const searchTables = Object.freeze({ workbenchSearchDocuments });
export type SearchSchemaRows = {
  [Name in keyof typeof searchTables]: SelectRow<(typeof searchTables)[Name]>;
};
export const searchSchemaHistory = defineSubsystemHistory([workbenchSearchDocumentsHistory]);
