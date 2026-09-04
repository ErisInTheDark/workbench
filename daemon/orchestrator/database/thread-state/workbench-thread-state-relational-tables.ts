/*
 * Exports:
 * - relational table constants and registries: identify permanent thread-state tables, dependency order, and primary keys. Keywords: thread state, relational, sqlite.
 * - SqlValue/SqlRow/RowSets: projector-owned relational row shapes. Keywords: thread state, relational, rows.
 * - addRow/canonicalRows/rowKey/rowSignatures: deterministic row collection and comparison. Keywords: relational, parity, reconciliation.
 * - threadKey/layoutItemId/questionnaireId: stable relational identities. Keywords: thread state, identity, projection.
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
  [IDENTITY_TABLE]: ["thread_id"],
  [LIFECYCLE_TABLE]: ["thread_id"],
  [SUBAGENT_TABLE]: ["thread_id"],
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

function encodePart(value: string) {
  return `${value.length}:${value}`;
}

export function threadKey(harness: string, providerThreadId: string) {
  return `thread:${encodePart(harness)}${encodePart(providerThreadId)}`;
}

export function layoutItemId(layoutId: string, key: string) {
  return `layout-item:${encodePart(layoutId)}${encodePart(key)}`;
}

export function questionnaireId(threadId: string, providerItemId: string | null, turnId: string | null, requestKey: string) {
  return `questionnaire:${encodePart(threadId)}${encodePart(providerItemId ?? "")}${encodePart(turnId ?? "")}${encodePart(requestKey)}`;
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
