/*
 * Keywords: thread state, relational projection, table keys, reconciliation.
 * Exports:
 * - SqlValue: bound SQL scalar.
 * - SqlRow: named SQL values.
 * - RowSets: projected rows by table.
 * - PROJECT_DOCUMENT_TABLE: source project documents.
 * - GLOBAL_DOCUMENT_TABLE: source global documents.
 * - PROJECTION_STATUS_TABLE: projection health.
 * - THREAD_TABLE: canonical thread roots.
 * - IDENTITY_TABLE: private native references.
 * - LIFECYCLE_TABLE: lifecycle variants.
 * - SUBAGENT_TABLE: child thread metadata.
 * - SUBAGENT_PARENT_TABLE: parent identities.
 * - SUBAGENT_RELATIONSHIP_TABLE: relationship roots.
 * - PENDING_SUBAGENT_RELATIONSHIP_TABLE: pending reservations.
 * - ACTIVE_SUBAGENT_RELATIONSHIP_TABLE: active child references.
 * - RETENTION_TABLE: cleanup metadata.
 * - PROFILE_TABLE: thread profile selections.
 * - PROJECT_PROFILE_TABLE: project profile defaults.
 * - SNOOZE_TABLE: wake dependencies.
 * - DRAFT_TABLE: durable draft inputs.
 * - ATTACHMENT_TABLE: opaque draft attachments.
 * - LAYOUT_TABLE: layout roots.
 * - PROJECT_LAYOUT_TABLE: project layout owners.
 * - GLOBAL_LAYOUT_TABLE: global layout owners.
 * - FOLDER_TABLE: folder metadata.
 * - LAYOUT_ITEM_TABLE: typed layout members.
 * - LAYOUT_THREAD_TABLE: thread member targets.
 * - LAYOUT_DRAFT_TABLE: draft member targets.
 * - LAYOUT_FOLDER_TABLE: folder member targets.
 * - LAYOUT_RELATION_TABLE: sidebar ordering relations.
 * - FOLDER_MEMBER_TABLE: ordered folder membership.
 * - PINNED_IMPORT_TABLE: imported project markers.
 * - QUESTIONNAIRE_TABLE: interaction roots.
 * - QUESTION_TABLE: ordered questions.
 * - OPTION_TABLE: offered choices.
 * - ANSWER_TABLE: settled answers.
 * - RELATIONAL_TABLES: insertion dependency order.
 * - RelationalTableName: projected table names.
 * - DELETE_ORDER: child-first deletion order.
 * - RELATIONAL_TABLE_KEYS: row identity columns.
 * - providerReferenceKey: private map key for a project/provider/native reference, never an entity id.
 * - addRow: collect a projected row.
 * - canonicalRows: normalise row comparison fields.
 * - rowSignatures: compare unordered row collections.
 * - rowKey: serialise relational lookup columns.
 */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export type RowSets = Map<string, SqlRow[]>;

export const PROJECT_DOCUMENT_TABLE = "workbench_thread_state_projects";
export const GLOBAL_DOCUMENT_TABLE = "workbench_thread_state_globals";
export const PROJECTION_STATUS_TABLE = "workbench_thread_state_projection_status";
export const THREAD_TABLE = "workbench_thread_state_threads";
export const IDENTITY_TABLE = "workbench_thread_state_provider_identities";
export const LIFECYCLE_TABLE = "workbench_thread_state_lifecycles";
export const SUBAGENT_TABLE = "workbench_thread_state_subagents";
export const SUBAGENT_PARENT_TABLE = "workbench_thread_state_subagent_parents";
export const SUBAGENT_RELATIONSHIP_TABLE = "workbench_thread_state_subagent_relationships";
export const PENDING_SUBAGENT_RELATIONSHIP_TABLE = "workbench_thread_state_pending_subagent_relationships";
export const ACTIVE_SUBAGENT_RELATIONSHIP_TABLE = "workbench_thread_state_active_subagent_relationships";
export const RETENTION_TABLE = "workbench_thread_state_retention";
export const PROFILE_TABLE = "workbench_thread_state_profiles";
export const PROJECT_PROFILE_TABLE = "workbench_thread_state_project_profiles";
export const SNOOZE_TABLE = "workbench_thread_state_snooze_dependencies";
export const DRAFT_TABLE = "workbench_thread_state_drafts";
export const ATTACHMENT_TABLE = "workbench_thread_state_draft_attachments";
export const LAYOUT_TABLE = "workbench_thread_state_layouts";
export const PROJECT_LAYOUT_TABLE = "workbench_thread_state_project_layouts";
export const GLOBAL_LAYOUT_TABLE = "workbench_thread_state_global_layouts";
export const FOLDER_TABLE = "workbench_thread_state_layout_folders";
export const LAYOUT_ITEM_TABLE = "workbench_thread_state_layout_items";
export const LAYOUT_THREAD_TABLE = "workbench_thread_state_layout_thread_items";
export const LAYOUT_DRAFT_TABLE = "workbench_thread_state_layout_draft_items";
export const LAYOUT_FOLDER_TABLE = "workbench_thread_state_layout_folder_items";
export const LAYOUT_RELATION_TABLE = "workbench_thread_state_layout_relations";
export const FOLDER_MEMBER_TABLE = "workbench_thread_state_folder_members";
export const PINNED_IMPORT_TABLE = "workbench_thread_state_pinned_imports";
export const QUESTIONNAIRE_TABLE = "workbench_thread_state_questionnaires";
export const QUESTION_TABLE = "workbench_thread_state_questionnaire_questions";
export const OPTION_TABLE = "workbench_thread_state_questionnaire_options";
export const ANSWER_TABLE = "workbench_thread_state_questionnaire_answers";

export const RELATIONAL_TABLES = [
  THREAD_TABLE,
  IDENTITY_TABLE,
  LIFECYCLE_TABLE,
  SUBAGENT_TABLE,
  SUBAGENT_PARENT_TABLE,
  SUBAGENT_RELATIONSHIP_TABLE,
  PENDING_SUBAGENT_RELATIONSHIP_TABLE,
  ACTIVE_SUBAGENT_RELATIONSHIP_TABLE,
  RETENTION_TABLE,
  PROFILE_TABLE,
  PROJECT_PROFILE_TABLE,
  SNOOZE_TABLE,
  DRAFT_TABLE,
  ATTACHMENT_TABLE,
  LAYOUT_TABLE,
  PROJECT_LAYOUT_TABLE,
  GLOBAL_LAYOUT_TABLE,
  FOLDER_TABLE,
  LAYOUT_ITEM_TABLE,
  LAYOUT_THREAD_TABLE,
  LAYOUT_DRAFT_TABLE,
  LAYOUT_FOLDER_TABLE,
  LAYOUT_RELATION_TABLE,
  FOLDER_MEMBER_TABLE,
  PINNED_IMPORT_TABLE,
  QUESTIONNAIRE_TABLE,
  QUESTION_TABLE,
  OPTION_TABLE,
  ANSWER_TABLE,
] as const;

export type RelationalTableName = typeof RELATIONAL_TABLES[number];

export const DELETE_ORDER: readonly RelationalTableName[] = [
  ACTIVE_SUBAGENT_RELATIONSHIP_TABLE,
  PENDING_SUBAGENT_RELATIONSHIP_TABLE,
  SUBAGENT_RELATIONSHIP_TABLE,
  SUBAGENT_PARENT_TABLE,
  ANSWER_TABLE,
  OPTION_TABLE,
  QUESTION_TABLE,
  QUESTIONNAIRE_TABLE,
  FOLDER_MEMBER_TABLE,
  LAYOUT_RELATION_TABLE,
  LAYOUT_FOLDER_TABLE,
  LAYOUT_DRAFT_TABLE,
  LAYOUT_THREAD_TABLE,
  LAYOUT_ITEM_TABLE,
  PINNED_IMPORT_TABLE,
  FOLDER_TABLE,
  GLOBAL_LAYOUT_TABLE,
  PROJECT_LAYOUT_TABLE,
  LAYOUT_TABLE,
  ATTACHMENT_TABLE,
  DRAFT_TABLE,
  SNOOZE_TABLE,
  PROFILE_TABLE,
  PROJECT_PROFILE_TABLE,
  RETENTION_TABLE,
  SUBAGENT_TABLE,
  LIFECYCLE_TABLE,
  IDENTITY_TABLE,
  THREAD_TABLE,
];

export const RELATIONAL_TABLE_KEYS: Record<RelationalTableName, readonly string[]> = {
  [THREAD_TABLE]: ["id"],
  [IDENTITY_TABLE]: ["project_id", "harness_id", "provider_thread_id"],
  [LIFECYCLE_TABLE]: ["thread_id"],
  [SUBAGENT_TABLE]: ["thread_id"],
  [SUBAGENT_PARENT_TABLE]: ["id"],
  [SUBAGENT_RELATIONSHIP_TABLE]: ["id"],
  [PENDING_SUBAGENT_RELATIONSHIP_TABLE]: ["relationship_id"],
  [ACTIVE_SUBAGENT_RELATIONSHIP_TABLE]: ["relationship_id"],
  [RETENTION_TABLE]: ["thread_id"],
  [PROFILE_TABLE]: ["thread_id"],
  [PROJECT_PROFILE_TABLE]: ["project_id"],
  [SNOOZE_TABLE]: ["source_thread_id"],
  [DRAFT_TABLE]: ["draft_id"],
  [ATTACHMENT_TABLE]: ["draft_id", "attachment_index"],
  [LAYOUT_TABLE]: ["id"],
  [PROJECT_LAYOUT_TABLE]: ["layout_id"],
  [GLOBAL_LAYOUT_TABLE]: ["layout_id"],
  [FOLDER_TABLE]: ["folder_id"],
  [LAYOUT_ITEM_TABLE]: ["id"],
  [LAYOUT_THREAD_TABLE]: ["item_id"],
  [LAYOUT_DRAFT_TABLE]: ["item_id"],
  [LAYOUT_FOLDER_TABLE]: ["item_id"],
  [LAYOUT_RELATION_TABLE]: ["item_id", "relation_kind", "relation_index"],
  [FOLDER_MEMBER_TABLE]: ["folder_item_id", "member_index"],
  [PINNED_IMPORT_TABLE]: ["project_id"],
  [QUESTIONNAIRE_TABLE]: ["id"],
  [QUESTION_TABLE]: ["questionnaire_id", "question_index"],
  [OPTION_TABLE]: ["questionnaire_id", "question_index", "option_index"],
  [ANSWER_TABLE]: ["questionnaire_id", "question_id", "answer_index"],
};

export function providerReferenceKey(projectId: string, harness: string, providerThreadId: string) {
  return JSON.stringify([projectId, harness, providerThreadId]);
}

export function addRow(rows: RowSets, table: string, row: SqlRow) {
  let values = rows.get(table);
  if (!values) {
    values = [];
    rows.set(table, values);
  }
  values.push(row);
}

export function canonicalRows(value: SqlRow) {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key] ?? null])) as SqlRow;
}

export function rowSignatures(rows: readonly SqlRow[]) {
  return rows.map(canonicalRows).map((row) => JSON.stringify(row)).sort();
}

export function rowKey(table: RelationalTableName, row: SqlRow) {
  return JSON.stringify(RELATIONAL_TABLE_KEYS[table].map((column) => row[column]));
}
