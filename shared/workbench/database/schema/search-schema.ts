/*
 * Exports:
 * - workbenchSearchDocuments: SQLite-backed project, file, setting, and action search projection.
 * - workbenchSearchNarratives: user and agent message text kept searchable after transcript retention expires its items.
 * - searchTables/SearchSchemaRows/searchSchemaHistory: current search table registry, row types, and migration history.
 */
import databaseReleases from "./releases.ts";
import { ownProjectReferences } from "./project-schema.ts";
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

export const workbenchSearchNarratives = defineTable("workbench_search_narratives", {
  id: integer().primaryKey({ autoincrement: true }),
  item_public_id: text().notNull().unique(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  role: enumText("user", "assistant").notNull(),
  text: text().notNull(),
}, (table) => ({
  indexes: [index("workbench_search_narratives_thread_idx", [table.thread_id])],
}));

const workbenchSearchDocumentsHistory = defineTableHistory({
  current: workbenchSearchDocuments,
  versions: [tableVersion({
    migration: createTable(workbenchSearchDocuments),
    schemaVersion: databaseReleases.search.version,
    table: workbenchSearchDocuments,
  })],
});

const workbenchSearchNarrativesHistory = defineTableHistory({
  current: workbenchSearchNarratives,
  versions: [tableVersion({
    migration: createTable(workbenchSearchNarratives),
    schemaVersion: databaseReleases.retainedSearchNarrative.version,
    table: workbenchSearchNarratives,
  })],
});

export const searchTables = Object.freeze({ workbenchSearchDocuments, workbenchSearchNarratives });
export type SearchSchemaRows = {
  [Name in keyof typeof searchTables]: SelectRow<(typeof searchTables)[Name]>;
};
export const searchSchemaHistory = defineSubsystemHistory([
  ownProjectReferences(workbenchSearchDocumentsHistory),
  workbenchSearchNarrativesHistory,
]);
