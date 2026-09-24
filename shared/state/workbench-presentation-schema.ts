/*
 * Exports:
 * - presentationTables/PresentationRows: typed app-wide project, draft and layout storage.
 * - presentationSchema: protected relational history for the shared presentation database.
 */
import {
  blob, booleanInteger, defineTable, enumText, foreignKey, integer, primaryKey, text, unique,
  type SelectRow, type TableDefinition,
} from "../database/schema/schema-definition.ts";
import {
  addColumns, createTable, defineSubsystemHistory, defineTableHistory, defineWorkbenchDatabaseSchema, sqlData, tableVersion,
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
const projectTable = defineTable("presentation_projects", {
  id: text().primaryKey(),
  match_key: text().notNull(),
  label: text().notNull(),
}, table => ({ constraints: [unique([table.match_key])] }));
const projects = defineTableHistory({
  current: projectTable,
  versions: [
    tableVersion({ schemaVersion: releases.initialPresentation.version,
      table: projectTable, migration: createTable(projectTable) }),
    tableVersion({ schemaVersion: releases.convergedIdentity.version, table: projectTable,
      migration: sqlData([
        `CREATE TEMP TABLE presentation_project_convergence AS
          WITH keys AS (
            SELECT id AS old_id,
              CASE WHEN substr(match_key, 37, 1) = ':'
                AND (substr(match_key, 38) LIKE 'local://%'
                  OR substr(match_key, 38) LIKE 'workspace://%'
                  OR substr(match_key, 38) LIKE 'remote://%')
                THEN substr(match_key, 38) ELSE match_key END AS canonical_key
            FROM presentation_projects
          )
          SELECT old_id, canonical_key,
            MIN(old_id) OVER (PARTITION BY canonical_key) AS winner_id FROM keys`,
        `CREATE TEMP TABLE presentation_folder_order AS
          SELECT f.id, ROW_NUMBER() OVER (
            PARTITION BY f.scope, c.winner_id ORDER BY f.logical_project_id, f.position, f.id
          ) - 1 AS position
          FROM presentation_folders f
          JOIN presentation_project_convergence c ON c.old_id = f.logical_project_id
          WHERE f.scope = 'project'`,
        `CREATE TEMP TABLE presentation_member_order AS
          SELECT m.id, ROW_NUMBER() OVER (
            PARTITION BY m.scope, c.winner_id ORDER BY m.logical_project_id, m.position, m.id
          ) - 1 AS position
          FROM presentation_layout_members m
          JOIN presentation_project_convergence c ON c.old_id = m.logical_project_id
          WHERE m.scope = 'project'`,
        `UPDATE presentation_locations SET logical_project_id = (
          SELECT winner_id FROM presentation_project_convergence WHERE old_id = logical_project_id
        )`,
        `UPDATE presentation_drafts SET logical_project_id = (
          SELECT winner_id FROM presentation_project_convergence WHERE old_id = logical_project_id
        )`,
        `UPDATE presentation_folders SET logical_project_id = (
          SELECT winner_id FROM presentation_project_convergence WHERE old_id = logical_project_id
        ), position = (SELECT position FROM presentation_folder_order WHERE id = presentation_folders.id)
          WHERE scope = 'project'`,
        `UPDATE presentation_layout_members SET logical_project_id = (
          SELECT winner_id FROM presentation_project_convergence WHERE old_id = logical_project_id
        ), position = (SELECT position FROM presentation_member_order WHERE id = presentation_layout_members.id)
          WHERE scope = 'project'`,
        `UPDATE presentation_import_receipts SET target_id = (
          SELECT winner_id FROM presentation_project_convergence WHERE old_id = target_id
        ) WHERE source_kind = 'layout' AND target_id IN (
          SELECT old_id FROM presentation_project_convergence
        )`,
        `DELETE FROM presentation_projects WHERE id IN (
          SELECT old_id FROM presentation_project_convergence WHERE old_id <> winner_id
        )`,
        `UPDATE presentation_projects SET match_key = (
          SELECT canonical_key FROM presentation_project_convergence WHERE old_id = id
        )`,
        `UPDATE presentation_metadata SET revision = revision + 1 WHERE id = 'singleton'`,
        `DROP TABLE presentation_member_order`,
        `DROP TABLE presentation_folder_order`,
        `DROP TABLE presentation_project_convergence`,
      ]) }),
  ],
});
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
const initialDraftTable = defineTable("presentation_drafts", {
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
}));
const draftTable = defineTable("presentation_drafts", {
  ...initialDraftTable.columns,
  pinned: booleanInteger().notNull().default(0),
  snoozed: booleanInteger().notNull().default(0),
}, table => ({
  constraints: [
    unique([table.launch_id]),
    foreignKey([table.daemon_id, table.project_id], {
      table: "presentation_locations", columns: ["daemon_id", "project_id"],
    }),
  ],
}));
const drafts = defineTableHistory({
  current: draftTable,
  versions: [
    tableVersion({ schemaVersion: releases.initialPresentation.version,
      table: initialDraftTable, migration: createTable(initialDraftTable) }),
    tableVersion({ schemaVersion: releases.convergedIdentity.version,
      table: draftTable, migration: addColumns({
        from: initialDraftTable, to: draftTable, columns: ["pinned", "snoozed"],
      }) }),
  ],
});
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
