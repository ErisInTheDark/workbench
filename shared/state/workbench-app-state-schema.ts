/*
 * Exports:
 * - appStateClientTables: current app-state tables admitted to the browser wire boundary. Keywords: app, browser, SQLite, state.
 * - appStateTables: complete typed table inventory for app-owned preferences and recoverable drafts. Keywords: app, SQLite, state, schema.
 * - appStateTableInventory: current tables keyed by SQLite name for checked statement compilation. Keywords: app, SQLite, statements.
 * - appStateSchema: versioned app-state schema installed by the repository. Keywords: app, SQLite, schema, history.
 * - AppStateRows: inferred selected row types for app-state tables. Keywords: app, SQLite, rows, types.
 */
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  foreignKey,
  integer,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type ColumnDefinition,
  type TableDefinition,
} from "../database/schema/schema-definition.ts";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  defineWorkbenchDatabaseSchema,
  rebuildTable,
  tableVersion,
} from "../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({ migration: createTable(table), schemaVersion: 1, table })],
  });
}

function revisionColumns() {
  return {
    deleted: booleanInteger().notNull().default(0),
    revision: integer().notNull().nonNegative(),
  };
}

function registrationForeignKey() {
  return text().notNull().references("daemon_registrations", "id", { onDelete: "CASCADE" });
}

const appStateMetadataHistory = initialHistory(defineTable("app_state_metadata", {
  id: enumText("singleton").primaryKey(),
  oldest_available_revision: integer().notNull().default(0).nonNegative(),
  revision: integer().notNull().default(0).nonNegative(),
}));

const daemonRegistrationsHistory = initialHistory(defineTable("daemon_registrations", {
  id: text().primaryKey(),
  kind: enumText("local").notNull(),
  created_at: integer().notNull().nonNegative(),
  revision: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [unique([table.kind])],
})));

const lastLaunchTargetHistory = initialHistory(defineTable("last_launch_target", {
  id: enumText("singleton").primaryKey(),
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    check(sql`${table.deleted} = ${literal(0)} OR ${table.project_id} = ${literal("")}`),
  ],
})));

const globalPreferencesV1 = defineTable("global_preferences", {
  key: enumText(
    "composerSpellCheck",
    "editorFontFamily",
    "editorFontSize",
    "editorSpellCheck",
    "fileOpenBehavior",
    "harness",
    "showUnopenableFiles",
    "theme",
    "threadCodeBlockWrap",
    "threadLiveActivityOpen",
  ).primaryKey(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  text_value: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND (
        (${table.key} IN (${literal("composerSpellCheck")}, ${literal("editorSpellCheck")}, ${literal("showUnopenableFiles")}, ${literal("threadCodeBlockWrap")}, ${literal("threadLiveActivityOpen")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
        OR (${table.key} = ${literal("editorFontSize")} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("editorFontFamily")}, ${literal("fileOpenBehavior")}, ${literal("harness")}, ${literal("theme")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NOT NULL)
      ))
    `),
  ],
}));

const globalPreferencesV2 = defineTable("global_preferences", {
  key: enumText(
    "appPort",
    "composerSpellCheck",
    "editorFontFamily",
    "editorFontSize",
    "editorSpellCheck",
    "fileOpenBehavior",
    "harness",
    "showUnopenableFiles",
    "theme",
    "threadCodeBlockWrap",
    "threadLiveActivityOpen",
  ).primaryKey(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  text_value: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND (
        (${table.key} IN (${literal("composerSpellCheck")}, ${literal("editorSpellCheck")}, ${literal("showUnopenableFiles")}, ${literal("threadCodeBlockWrap")}, ${literal("threadLiveActivityOpen")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("appPort")}, ${literal("editorFontSize")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("editorFontFamily")}, ${literal("fileOpenBehavior")}, ${literal("harness")}, ${literal("theme")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NOT NULL)
      ))
    `),
  ],
}));

const globalPreferencesV3 = defineTable("global_preferences", {
  key: enumText(
    "appPort",
    "composerSpellCheck",
    "editorFontFamily",
    "editorFontSize",
    "editorSpellCheck",
    "fileOpenBehavior",
    "harness",
    "selectedProjectPinPlacement",
    "showUnopenableFiles",
    "theme",
    "threadCodeBlockWrap",
    "threadLiveActivityOpen",
  ).primaryKey(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  text_value: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND (
        (${table.key} IN (${literal("composerSpellCheck")}, ${literal("editorSpellCheck")}, ${literal("showUnopenableFiles")}, ${literal("threadCodeBlockWrap")}, ${literal("threadLiveActivityOpen")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("appPort")}, ${literal("editorFontSize")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("editorFontFamily")}, ${literal("fileOpenBehavior")}, ${literal("harness")}, ${literal("selectedProjectPinPlacement")}, ${literal("theme")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NOT NULL)
      ))
    `),
  ],
}));

const globalPreferencesHistory = defineTableHistory({
  versions: [
    tableVersion({ migration: createTable(globalPreferencesV1), schemaVersion: 1, table: globalPreferencesV1 }),
    tableVersion({
      migration: rebuildTable({ from: globalPreferencesV1, to: globalPreferencesV2 }),
      schemaVersion: 2,
      table: globalPreferencesV2,
    }),
    tableVersion({
      migration: rebuildTable({ from: globalPreferencesV2, to: globalPreferencesV3 }),
      schemaVersion: 3,
      table: globalPreferencesV3,
    }),
  ],
  current: globalPreferencesV3,
});

const projectPreferencesV1 = defineTable("project_preferences", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  key: enumText(
    "composerSpellCheck",
    "editorFontFamily",
    "editorFontSize",
    "editorSpellCheck",
    "fileOpenBehavior",
    "showUnopenableFiles",
    "theme",
    "threadCodeBlockWrap",
  ).notNull(),
  enabled: booleanInteger(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  text_value: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.key]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.enabled} IS NULL AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND ${table.enabled} IS NOT NULL AND (
        (${table.key} IN (${literal("composerSpellCheck")}, ${literal("editorSpellCheck")}, ${literal("showUnopenableFiles")}, ${literal("threadCodeBlockWrap")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
        OR (${table.key} = ${literal("editorFontSize")} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("editorFontFamily")}, ${literal("fileOpenBehavior")}, ${literal("theme")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NOT NULL)
      ))
    `),
  ],
}));

const projectPreferencesV2 = defineTable("project_preferences", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  key: enumText(
    "composerSpellCheck",
    "editorFontFamily",
    "editorFontSize",
    "editorSpellCheck",
    "fileOpenBehavior",
    "selectedProjectPinPlacement",
    "showUnopenableFiles",
    "theme",
    "threadCodeBlockWrap",
  ).notNull(),
  enabled: booleanInteger(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  text_value: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.key]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.enabled} IS NULL AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND ${table.enabled} IS NOT NULL AND (
        (${table.key} IN (${literal("composerSpellCheck")}, ${literal("editorSpellCheck")}, ${literal("showUnopenableFiles")}, ${literal("threadCodeBlockWrap")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NULL)
        OR (${table.key} = ${literal("editorFontSize")} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL AND ${table.text_value} IS NULL)
        OR (${table.key} IN (${literal("editorFontFamily")}, ${literal("fileOpenBehavior")}, ${literal("selectedProjectPinPlacement")}, ${literal("theme")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL AND ${table.text_value} IS NOT NULL)
      ))
    `),
  ],
}));

const projectPreferencesHistory = defineTableHistory({
  versions: [
    tableVersion({ migration: createTable(projectPreferencesV1), schemaVersion: 1, table: projectPreferencesV1 }),
    tableVersion({
      migration: rebuildTable({ from: projectPreferencesV1, to: projectPreferencesV2 }),
      schemaVersion: 3,
      table: projectPreferencesV2,
    }),
  ],
  current: projectPreferencesV2,
});

const projectSidebarPreferencesHistory = initialHistory(defineTable("project_sidebar_preferences", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  key: enumText(
    "browseSessionsOpen",
    "explorerOpen",
    "pinnedStatusCountsExpanded",
    "pinnedThreadsOpen",
    "projectStatusCountsExpanded",
    "projectsOpen",
    "projectTimeGroupCount",
    "reloadNecessaryOpen",
    "settledThreadItemLimit",
    "settledThreadsOpen",
    "sidebarCollapsed",
    "threadsOpen",
  ).notNull(),
  boolean_value: booleanInteger(),
  integer_value: integer(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.key]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND (
        (${table.key} IN (${literal("projectTimeGroupCount")}, ${literal("settledThreadItemLimit")}) AND ${table.boolean_value} IS NULL AND ${table.integer_value} IS NOT NULL)
        OR (${table.key} NOT IN (${literal("projectTimeGroupCount")}, ${literal("settledThreadItemLimit")}) AND ${table.boolean_value} IS NOT NULL AND ${table.integer_value} IS NULL)
      ))
    `),
  ],
})));

const projectSidebarFoldersHistory = initialHistory(defineTable("project_sidebar_folders", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  scope: enumText("pinned", "thread").notNull(),
  folder_id: text().notNull(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [primaryKey([table.daemon_registration_id, table.project_id, table.scope, table.folder_id])],
})));

const projectExpandedDirectoriesHistory = initialHistory(defineTable("project_expanded_directories", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  path: text().notNull(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [primaryKey([table.daemon_registration_id, table.project_id, table.path])],
})));

const harnessPreferencesHistory = initialHistory(defineTable("harness_preferences", {
  daemon_registration_id: registrationForeignKey(),
  harness: enumText("codex", "copilot", "opencode").notNull(),
  model: text(),
  service_tier: enumText("fast"),
  agent_path: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [primaryKey([table.daemon_registration_id, table.harness])],
})));

const harnessModelEffortsHistory = initialHistory(defineTable("harness_model_efforts", {
  daemon_registration_id: registrationForeignKey(),
  harness: enumText("codex", "copilot", "opencode").notNull(),
  model: text().notNull(),
  reasoning_effort: text(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [primaryKey([table.daemon_registration_id, table.harness, table.model])],
})));

const threadServiceTiersHistory = initialHistory(defineTable("thread_service_tiers", {
  daemon_registration_id: registrationForeignKey(),
  harness: enumText("codex", "copilot", "opencode").notNull(),
  thread_id: text().notNull(),
  service_tier: enumText("fast"),
  ...revisionColumns(),
}, (table) => ({
  constraints: [primaryKey([table.daemon_registration_id, table.harness, table.thread_id])],
})));

const fileDraftsHistory = initialHistory(defineTable("file_drafts", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  path: text().notNull(),
  baseline_content: text(),
  content: text(),
  expected_mtime_ms: integer(),
  head_content: text(),
  mode: enumText("rich", "plain"),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.path]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.baseline_content} IS NULL AND ${table.content} IS NULL AND ${table.expected_mtime_ms} IS NULL AND ${table.head_content} IS NULL AND ${table.mode} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND ${table.baseline_content} IS NOT NULL AND ${table.content} IS NOT NULL AND ${table.mode} IS NOT NULL)
    `),
  ],
})));

const composerDraftsHistory = initialHistory(defineTable("composer_drafts", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  text: text(),
  updated_at: integer(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.text} IS NULL AND ${table.updated_at} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND ${table.text} IS NOT NULL AND ${table.updated_at} IS NOT NULL)
    `),
    unique([table.daemon_registration_id, table.project_id, table.thread_id, table.deleted]),
  ],
})));

const composerDraftAttachmentsHistory = initialHistory(defineTable("composer_draft_attachments", {
  daemon_registration_id: text().notNull(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  owner_deleted: booleanInteger().notNull().default(0),
  id: text().notNull(),
  url: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id, table.id]),
    foreignKey([table.daemon_registration_id, table.project_id, table.thread_id, table.owner_deleted], {
      columns: ["daemon_registration_id", "project_id", "thread_id", "deleted"],
      onDelete: "CASCADE",
      table: "composer_drafts",
    }),
    check(sql`${table.owner_deleted} = ${literal(0)}`),
  ],
})));

const questionnaireDraftsHistory = initialHistory(defineTable("questionnaire_drafts", {
  daemon_registration_id: registrationForeignKey(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  request_key: text().notNull(),
  updated_at: integer(),
  ...revisionColumns(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key]),
    check(sql`
      (${table.deleted} = ${literal(1)} AND ${table.updated_at} IS NULL)
      OR (${table.deleted} = ${literal(0)} AND ${table.updated_at} IS NOT NULL)
    `),
    unique([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key, table.deleted]),
  ],
})));

function questionnaireOwnerConstraints(table: {
  daemon_registration_id: Parameters<typeof foreignKey>[0][number];
  owner_deleted: Parameters<typeof foreignKey>[0][number];
  project_id: Parameters<typeof foreignKey>[0][number];
  request_key: Parameters<typeof foreignKey>[0][number];
  thread_id: Parameters<typeof foreignKey>[0][number];
}) {
  return [
    foreignKey([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key, table.owner_deleted], {
      columns: ["daemon_registration_id", "project_id", "thread_id", "request_key", "deleted"],
      onDelete: "CASCADE",
      table: "questionnaire_drafts",
    }),
    check(sql`${table.owner_deleted} = ${literal(0)}`),
  ];
}

const questionnaireDraftAnswersHistory = initialHistory(defineTable("questionnaire_draft_answers", {
  daemon_registration_id: text().notNull(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  request_key: text().notNull(),
  owner_deleted: booleanInteger().notNull().default(0),
  key: text().notNull(),
  answer: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key, table.key]),
    ...questionnaireOwnerConstraints(table),
  ],
})));

const questionnaireDraftSelectionsHistory = initialHistory(defineTable("questionnaire_draft_selections", {
  daemon_registration_id: text().notNull(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  request_key: text().notNull(),
  owner_deleted: booleanInteger().notNull().default(0),
  key: text().notNull(),
  value: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key, table.key, table.value]),
    ...questionnaireOwnerConstraints(table),
  ],
})));

const questionnaireDraftAttachmentsHistory = initialHistory(defineTable("questionnaire_draft_attachments", {
  daemon_registration_id: text().notNull(),
  project_id: text().notNull(),
  thread_id: text().notNull(),
  request_key: text().notNull(),
  owner_deleted: booleanInteger().notNull().default(0),
  key: text().notNull(),
  url: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.daemon_registration_id, table.project_id, table.thread_id, table.request_key, table.key]),
    ...questionnaireOwnerConstraints(table),
  ],
})));

const histories = [
  appStateMetadataHistory,
  daemonRegistrationsHistory,
  lastLaunchTargetHistory,
  globalPreferencesHistory,
  projectPreferencesHistory,
  projectSidebarPreferencesHistory,
  projectSidebarFoldersHistory,
  projectExpandedDirectoriesHistory,
  harnessPreferencesHistory,
  harnessModelEffortsHistory,
  threadServiceTiersHistory,
  fileDraftsHistory,
  composerDraftsHistory,
  composerDraftAttachmentsHistory,
  questionnaireDraftsHistory,
  questionnaireDraftAnswersHistory,
  questionnaireDraftSelectionsHistory,
  questionnaireDraftAttachmentsHistory,
] as const;

export const appStateClientTables = Object.freeze({
  composerDraftAttachments: composerDraftAttachmentsHistory.current,
  composerDrafts: composerDraftsHistory.current,
  fileDrafts: fileDraftsHistory.current,
  globalPreferences: globalPreferencesHistory.current,
  harnessModelEfforts: harnessModelEffortsHistory.current,
  harnessPreferences: harnessPreferencesHistory.current,
  lastLaunchTarget: lastLaunchTargetHistory.current,
  projectExpandedDirectories: projectExpandedDirectoriesHistory.current,
  projectPreferences: projectPreferencesHistory.current,
  projectSidebarFolders: projectSidebarFoldersHistory.current,
  projectSidebarPreferences: projectSidebarPreferencesHistory.current,
  questionnaireDraftAnswers: questionnaireDraftAnswersHistory.current,
  questionnaireDraftAttachments: questionnaireDraftAttachmentsHistory.current,
  questionnaireDraftSelections: questionnaireDraftSelectionsHistory.current,
  questionnaireDrafts: questionnaireDraftsHistory.current,
  threadServiceTiers: threadServiceTiersHistory.current,
});

export const appStateTables = Object.freeze({
  appStateMetadata: appStateMetadataHistory.current,
  daemonRegistrations: daemonRegistrationsHistory.current,
  ...appStateClientTables,
});

export const appStateTableInventory = Object.freeze(Object.fromEntries(
  Object.values(appStateTables).map((table) => [table.name, table]),
));

export const appStateSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory(histories)],
});

export type AppStateRows = {
  [Name in keyof typeof appStateTables]: SelectRow<(typeof appStateTables)[Name]>;
};
