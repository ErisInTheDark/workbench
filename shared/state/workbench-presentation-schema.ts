/*
 * Exports:
 * - presentationTables/PresentationRows: typed app-wide project, draft and layout storage.
 * - presentationSchema: protected relational history for the shared presentation database.
 */
import {
  blob, defineTable, enumText, foreignKey, integer, primaryKey, text, unique,
  type SelectRow, type TableDefinition,
} from "../database/schema/schema-definition.ts";
import {
  createTable, defineSubsystemHistory, defineTableHistory, defineWorkbenchDatabaseSchema, tableVersion,
} from "../database/schema/schema-history.ts";
import releases from "./workbench-presentation-releases.ts";

function initial<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({
      schemaVersion: releases.initialPresentation.version, table, migration: createTable(table),
    })],
  });
}

const metadata = initial(defineTable("presentation_metadata", {
  id: enumText("singleton").primaryKey(),
  revision: integer().notNull().nonNegative(),
}));
const daemons = initial(defineTable("presentation_daemons", {
  id: text().primaryKey(),
  hostname: text().notNull(),
  last_seen_at: integer().notNull().nonNegative(),
}));
const projects = initial(defineTable("presentation_projects", {
  id: text().primaryKey(),
  match_key: text().notNull(),
  label: text().notNull(),
}, table => ({ constraints: [unique([table.match_key])] })));
const locations = initial(defineTable("presentation_locations", {
  daemon_id: text().notNull().references("presentation_daemons", "id"),
  project_id: text().notNull(),
  logical_project_id: text().notNull().references("presentation_projects", "id"),
  identity_key: text().notNull(),
  name: text().notNull(),
  root_path: text().notNull(),
  observed_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.daemon_id, table.project_id])] })));
const defaults = initial(defineTable("presentation_new_thread_defaults", {
  daemon_id: text().notNull(),
  project_id: text().notNull(),
  selection_json: text().notNull(),
  revision: integer().notNull().nonNegative(),
}, table => ({
  constraints: [
    primaryKey([table.daemon_id, table.project_id]),
    foreignKey([table.daemon_id, table.project_id], {
      table: "presentation_locations", columns: ["daemon_id", "project_id"],
    }),
  ],
})));
const drafts = initial(defineTable("presentation_drafts", {
  id: text().primaryKey(),
  logical_project_id: text().notNull().references("presentation_projects", "id"),
  daemon_id: text().notNull(),
  project_id: text().notNull(),
  prompt: text().notNull(),
  selection_json: text().notNull(),
  phase: enumText("importing", "unsent", "submitting", "accepted", "deleted").notNull(),
  launch_id: text(),
  accepted_thread_id: text(),
  revision: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [
    unique([table.launch_id]),
    foreignKey([table.daemon_id, table.project_id], {
      table: "presentation_locations", columns: ["daemon_id", "project_id"],
    }),
  ],
})));
const attachments = initial(defineTable("presentation_draft_attachments", {
  draft_id: text().notNull().references("presentation_drafts", "id"),
  id: text().notNull(),
  media_type: text().notNull(),
  content_length: integer().notNull().nonNegative(),
  content_hash: text().notNull(),
}, table => ({ constraints: [primaryKey([table.draft_id, table.id])] })));
const attachmentChunks = initial(defineTable("presentation_attachment_chunks", {
  draft_id: text().notNull().references("presentation_drafts", "id"),
  attachment_id: text().notNull(),
  chunk_index: integer().notNull().nonNegative(),
  content: blob().notNull(),
}, table => ({ constraints: [primaryKey([table.draft_id, table.attachment_id, table.chunk_index])] })));
const folders = initial(defineTable("presentation_folders", {
  id: text().primaryKey(),
  scope: enumText("project", "home", "pinned").notNull(),
  logical_project_id: text().references("presentation_projects", "id"),
  title: text().notNull(),
  position: integer().notNull().nonNegative(),
  revision: integer().notNull().nonNegative(),
}));
const members = initial(defineTable("presentation_layout_members", {
  id: text().primaryKey(),
  scope: enumText("project", "home", "pinned").notNull(),
  logical_project_id: text().references("presentation_projects", "id"),
  folder_id: text().references("presentation_folders", "id"),
  kind: enumText("draft", "thread").notNull(),
  draft_id: text().references("presentation_drafts", "id"),
  daemon_id: text().references("presentation_daemons", "id"),
  project_id: text(),
  thread_id: text(),
  position: integer().notNull().nonNegative(),
  revision: integer().notNull().nonNegative(),
}));
const receipts = initial(defineTable("presentation_import_receipts", {
  daemon_id: text().notNull().references("presentation_daemons", "id"),
  source_kind: enumText("draft", "folder", "layout").notNull(),
  source_id: text().notNull(),
  target_id: text().notNull(),
  source_revision: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.daemon_id, table.source_kind, table.source_id])] })));
const mappings = initial(defineTable("presentation_source_mappings", {
  daemon_id: text().notNull().references("presentation_daemons", "id"),
  source_kind: enumText("draft", "folder", "member").notNull(),
  source_id: text().notNull(),
  target_id: text().notNull(),
  source_revision: integer().nonNegative(),
}, table => ({ constraints: [
  primaryKey([table.daemon_id, table.source_kind, table.source_id]),
  unique([table.source_kind, table.target_id]),
] })));
const importAttachments = initial(defineTable("presentation_import_attachments", {
  daemon_id: text().notNull().references("presentation_daemons", "id"),
  source_id: text().notNull(),
  attachment_id: text().notNull(),
  draft_id: text().notNull().references("presentation_drafts", "id"),
  media_type: text().notNull(),
  content_hash: text().notNull(),
  source_revision: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.daemon_id, table.source_id, table.attachment_id])] })));
const divergences = initial(defineTable("presentation_source_divergences", {
  daemon_id: text().notNull().references("presentation_daemons", "id"),
  source_kind: enumText("draft", "layout").notNull(),
  source_id: text().notNull(),
  imported_revision: integer().notNull().nonNegative(),
  latest_revision: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.daemon_id, table.source_kind, table.source_id])] })));

export const presentationTables = Object.freeze({
  metadata: metadata.current, daemons: daemons.current, projects: projects.current,
  locations: locations.current, defaults: defaults.current, drafts: drafts.current,
  attachments: attachments.current, attachmentChunks: attachmentChunks.current,
  folders: folders.current, members: members.current,
  receipts: receipts.current, mappings: mappings.current, importAttachments: importAttachments.current,
  divergences: divergences.current,
});
export type PresentationRows = { [Name in keyof typeof presentationTables]: SelectRow<(typeof presentationTables)[Name]> };
export const presentationSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([
    metadata, daemons, projects, locations, defaults, drafts, attachments, attachmentChunks,
    folders, members, receipts, mappings, importAttachments, divergences,
  ])],
});
