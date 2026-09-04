/*
 * Exports:
 * - workbenchThreadStateProjects/workbenchThreadStateGlobals: current authoritative thread-state document tables. Keywords: thread state, legacy, authority.
 * - threadStateRelationalTables: final-form relational thread-state tables, currently populated as a non-serving projection. Keywords: thread state, relational, parity.
 * - threadStateTables: complete current thread-state table inventory. Keywords: database, schema, thread state.
 * - ThreadStateSchemaRows: selected row types for current thread-state tables. Keywords: database, schema, types.
 * - threadStateSchemaHistory: private thread-state table histories. Keywords: database, schema, history.
 */
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  foreignKey,
  integer,
  jsonText,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "workbench-shared/database/schema/schema-history";

function initialHistory<Table extends TableDefinition>(table: Table, schemaVersion = 4) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    current: table,
  });
}

const workbenchThreadStateProjectsV1 = defineTable("workbench_thread_state_projects", {
  project_id: text().primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateProjectsHistory = initialHistory(workbenchThreadStateProjectsV1, 3);
export const workbenchThreadStateProjects = workbenchThreadStateProjectsHistory.current;

const workbenchThreadStateGlobalsV1 = defineTable("workbench_thread_state_globals", {
  id: enumText("homeDisplayOrder", "pinnedLayout").primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateGlobalsHistory = initialHistory(workbenchThreadStateGlobalsV1, 3);
export const workbenchThreadStateGlobals = workbenchThreadStateGlobalsHistory.current;

const workbenchThreadStateProjectionStatusV1 = defineTable("workbench_thread_state_projection_status", {
  id: integer().primaryKey(),
  generation: integer().notNull().nonNegative(),
  state: enumText("stale", "complete", "failed").notNull(),
  source_project_count: integer().notNull().nonNegative(),
  source_project_updated_at: integer().notNull().nonNegative(),
  source_subagent_parent_count: integer().notNull().nonNegative(),
  source_subagent_count: integer().notNull().nonNegative(),
  source_digest: text().notNull(),
  projected_thread_count: integer().notNull().nonNegative(),
  projected_subagent_count: integer().notNull().nonNegative(),
  mismatch_count: integer().notNull().nonNegative(),
  completed_at: integer(),
  error_text: text(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    check(sql`${table.id} = ${literal(1)}`),
    check(sql`length(${table.source_digest}) = ${literal(64)}`),
    check(sql`
      (${table.state} = ${literal("complete")} AND ${table.mismatch_count} = ${literal(0)} AND ${table.completed_at} IS NOT NULL AND ${table.error_text} IS NULL)
      OR (${table.state} = ${literal("stale")} AND ${table.completed_at} IS NULL AND ${table.error_text} IS NULL)
      OR (${table.state} = ${literal("failed")} AND ${table.completed_at} IS NULL AND ${table.error_text} IS NOT NULL)
    `),
  ],
}));
const workbenchThreadStateProjectionStatusHistory = initialHistory(workbenchThreadStateProjectionStatusV1);
export const workbenchThreadStateProjectionStatus = workbenchThreadStateProjectionStatusHistory.current;

const workbenchThreadStateThreadsV1 = defineTable("workbench_thread_state_threads", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  thread_kind: enumText("topLevel", "subagent").notNull(),
  visibility: enumText("visible", "placeholder").notNull().default("placeholder"),
  title: text().notNull(),
  archived: booleanInteger().notNull(),
  pinned: booleanInteger().notNull(),
  snoozed: booleanInteger().notNull(),
  provider_observed: booleanInteger().notNull(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  activity_at: integer().notNull().nonNegative(),
  order_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.id, table.thread_kind]),
    check(sql`
      (${table.thread_kind} = ${literal("topLevel")} AND (
        ${table.archived} = ${literal(0)}
        OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})
      ))
      OR (${table.thread_kind} = ${literal("subagent")}
        AND ${table.archived} = ${literal(0)}
        AND ${table.snoozed} = ${literal(0)}
        AND ${table.order_at} IS NULL)
    `),
  ],
}));
const workbenchThreadStateThreadsHistory = initialHistory(workbenchThreadStateThreadsV1);
export const workbenchThreadStateThreads = workbenchThreadStateThreadsHistory.current;

const workbenchThreadStateProviderIdentitiesV1 = defineTable("workbench_thread_state_provider_identities", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  provider_thread_id: text().notNull(),
}, (table) => ({
  constraints: [unique([table.harness_id, table.provider_thread_id])],
}));
const workbenchThreadStateProviderIdentitiesHistory = initialHistory(workbenchThreadStateProviderIdentitiesV1);
export const workbenchThreadStateProviderIdentities = workbenchThreadStateProviderIdentitiesHistory.current;

const workbenchThreadStateLifecyclesV1 = defineTable("workbench_thread_state_lifecycles", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  lifecycle_kind: enumText("working", "needsAttention", "completed", "stopped").notNull(),
  reason: enumText(
    "acceptedIntent",
    "pendingInput",
    "noActiveTurn",
    "agentBlocked",
    "agentCompleted",
    "userCompleted",
    "providerInactive",
    "providerInterrupted",
    "userMarkedStopped",
  ).notNull(),
  settled: booleanInteger().notNull(),
  provider_turn_id: text(),
  request_key: text(),
  agent_status: enumText("working", "completed", "blocked"),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.lifecycle_kind} = ${literal("working")}
        AND ${table.reason} = ${literal("acceptedIntent")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("working")})
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("pendingInput")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NOT NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("noActiveTurn")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("agentBlocked")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("blocked")})
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("agentCompleted")}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("completed")})
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("userCompleted")}
        AND ${table.request_key} IS NULL
        AND ((${table.provider_turn_id} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.provider_turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)))
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("providerInactive")}
        AND ${table.provider_turn_id} IS NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("stopped")}
        AND ${table.reason} = ${literal("providerInterrupted")}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("stopped")}
        AND ${table.reason} = ${literal("userMarkedStopped")}
        AND ${table.request_key} IS NULL
        AND ((${table.provider_turn_id} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.provider_turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)))
    `),
    check(sql`${table.settled} = ${literal(0)} OR ${table.lifecycle_kind} IN (${literal("completed")}, ${literal("stopped")})`),
  ],
}));
const workbenchThreadStateLifecyclesHistory = initialHistory(workbenchThreadStateLifecyclesV1);
export const workbenchThreadStateLifecycles = workbenchThreadStateLifecyclesHistory.current;

const workbenchThreadStateSubagentsV1 = defineTable("workbench_thread_state_subagents", {
  thread_id: text().primaryKey(),
  thread_kind: enumText("subagent").notNull().default("subagent"),
  parent_thread_id: text().notNull().references("workbench_thread_state_threads", "id"),
  cwd: text().notNull(),
  name: text().notNull(),
  name_key: text().notNull(),
  profile_id: text().notNull(),
  profile_name: text().notNull(),
  direct_subagent_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    foreignKey([table.thread_id, table.thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
      onDelete: "CASCADE",
    }),
    unique([table.parent_thread_id, table.direct_subagent_index]),
    unique([table.parent_thread_id, table.name_key]),
    check(sql`${table.thread_id} <> ${table.parent_thread_id}`),
  ],
}));
const workbenchThreadStateSubagentsHistory = initialHistory(workbenchThreadStateSubagentsV1);
export const workbenchThreadStateSubagents = workbenchThreadStateSubagentsHistory.current;

const workbenchThreadStateRetentionV1 = defineTable("workbench_thread_state_retention", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  settled_at: integer().nonNegative(),
  git_history_cleaned_at: integer().nonNegative(),
  mcp_generation: text(),
}, (table) => ({
  constraints: [check(sql`
    ${table.git_history_cleaned_at} IS NULL
    OR (${table.settled_at} IS NOT NULL AND ${table.git_history_cleaned_at} >= ${table.settled_at})
  `)],
}));
const workbenchThreadStateRetentionHistory = initialHistory(workbenchThreadStateRetentionV1);
export const workbenchThreadStateRetention = workbenchThreadStateRetentionHistory.current;

const profileColumns = {
  selection_kind: enumText("custom", "profile").notNull(),
  profile_id: text(),
  agent_path: text(),
  agent_source: enumText("library", "project"),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  model: text().notNull(),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
};

const workbenchThreadStateProfilesV1 = defineTable("workbench_thread_state_profiles", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  ...profileColumns,
}, (table) => ({
  constraints: [check(sql`
    (${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL)
    OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)
  `)],
}));
const workbenchThreadStateProfilesHistory = initialHistory(workbenchThreadStateProfilesV1);
export const workbenchThreadStateProfiles = workbenchThreadStateProfilesHistory.current;

const workbenchThreadStateProjectProfilesV1 = defineTable("workbench_thread_state_project_profiles", {
  project_id: text().primaryKey(),
  ...profileColumns,
}, (table) => ({
  constraints: [check(sql`
    (${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL)
    OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)
  `)],
}));
const workbenchThreadStateProjectProfilesHistory = initialHistory(workbenchThreadStateProjectProfilesV1);
export const workbenchThreadStateProjectProfiles = workbenchThreadStateProjectProfilesHistory.current;

const workbenchThreadStateSnoozeDependenciesV1 = defineTable("workbench_thread_state_snooze_dependencies", {
  source_thread_id: text().primaryKey(),
  source_thread_kind: enumText("topLevel").notNull().default("topLevel"),
  target_thread_id: text().notNull(),
  target_thread_kind: enumText("topLevel").notNull().default("topLevel"),
}, (table) => ({
  constraints: [
    foreignKey([table.source_thread_id, table.source_thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.target_thread_id, table.target_thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
    }),
    check(sql`${table.source_thread_id} <> ${table.target_thread_id}`),
  ],
}));
const workbenchThreadStateSnoozeDependenciesHistory = initialHistory(workbenchThreadStateSnoozeDependenciesV1);
export const workbenchThreadStateSnoozeDependencies = workbenchThreadStateSnoozeDependenciesHistory.current;

const workbenchThreadStateDraftsV1 = defineTable("workbench_thread_state_drafts", {
  draft_id: text().primaryKey(),
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  prompt: text().notNull(),
  profile_id: text(),
  agent_path: text(),
  agent_source: enumText("library", "project"),
  model: text().notNull(),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
  pinned: booleanInteger().notNull(),
  snoozed: booleanInteger().notNull(),
  client_updated_at: integer().notNull().nonNegative(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [check(sql`NOT (${table.pinned} = ${literal(1)} AND ${table.snoozed} = ${literal(1)})`)],
}));
const workbenchThreadStateDraftsHistory = initialHistory(workbenchThreadStateDraftsV1);
export const workbenchThreadStateDrafts = workbenchThreadStateDraftsHistory.current;

const workbenchThreadStateDraftAttachmentsV1 = defineTable("workbench_thread_state_draft_attachments", {
  draft_id: text().notNull().references("workbench_thread_state_drafts", "draft_id", { onDelete: "CASCADE" }),
  attachment_index: integer().notNull().nonNegative(),
  opaque_json: jsonText().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.draft_id, table.attachment_index])],
}));
const workbenchThreadStateDraftAttachmentsHistory = initialHistory(workbenchThreadStateDraftAttachmentsV1);
export const workbenchThreadStateDraftAttachments = workbenchThreadStateDraftAttachmentsHistory.current;

const workbenchThreadStateLayoutsV1 = defineTable("workbench_thread_state_layouts", {
  id: text().primaryKey(),
  owner_kind: enumText("project", "pinned", "home").notNull(),
  revision: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [unique([table.id, table.owner_kind])],
}));
const workbenchThreadStateLayoutsHistory = initialHistory(workbenchThreadStateLayoutsV1);
export const workbenchThreadStateLayouts = workbenchThreadStateLayoutsHistory.current;

const workbenchThreadStateProjectLayoutsV1 = defineTable("workbench_thread_state_project_layouts", {
  layout_id: text().primaryKey(),
  owner_kind: enumText("project").notNull().default("project"),
  project_id: text().notNull().unique(),
}, (table) => ({
  constraints: [foreignKey([table.layout_id, table.owner_kind], {
    table: "workbench_thread_state_layouts",
    columns: ["id", "owner_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateProjectLayoutsHistory = initialHistory(workbenchThreadStateProjectLayoutsV1);
export const workbenchThreadStateProjectLayouts = workbenchThreadStateProjectLayoutsHistory.current;

const workbenchThreadStateGlobalLayoutsV1 = defineTable("workbench_thread_state_global_layouts", {
  layout_id: text().primaryKey(),
  owner_kind: enumText("pinned", "home").notNull(),
}, (table) => ({
  constraints: [foreignKey([table.layout_id, table.owner_kind], {
    table: "workbench_thread_state_layouts",
    columns: ["id", "owner_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateGlobalLayoutsHistory = initialHistory(workbenchThreadStateGlobalLayoutsV1);
export const workbenchThreadStateGlobalLayouts = workbenchThreadStateGlobalLayoutsHistory.current;

const workbenchThreadStateLayoutFoldersV1 = defineTable("workbench_thread_state_layout_folders", {
  folder_id: text().primaryKey(),
  layout_id: text().notNull(),
  layout_owner_kind: enumText("project", "pinned").notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  title: text().notNull(),
}, (table) => ({
  constraints: [
    foreignKey([table.layout_id, table.layout_owner_kind], {
      table: "workbench_thread_state_layouts",
      columns: ["id", "owner_kind"],
      onDelete: "CASCADE",
    }),
    unique([table.folder_id, table.layout_id, table.section]),
  ],
}));
const workbenchThreadStateLayoutFoldersHistory = initialHistory(workbenchThreadStateLayoutFoldersV1);
export const workbenchThreadStateLayoutFolders = workbenchThreadStateLayoutFoldersHistory.current;

const workbenchThreadStateLayoutItemsV1 = defineTable("workbench_thread_state_layout_items", {
  id: text().primaryKey(),
  layout_id: text().notNull().references("workbench_thread_state_layouts", "id", { onDelete: "CASCADE" }),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  item_kind: enumText("thread", "draft", "folder").notNull(),
}, (table) => ({
  constraints: [
    unique([table.id, table.item_kind]),
    unique([table.id, table.layout_id, table.section]),
    unique([table.id, table.layout_id, table.section, table.item_kind]),
  ],
}));
const workbenchThreadStateLayoutItemsHistory = initialHistory(workbenchThreadStateLayoutItemsV1);
export const workbenchThreadStateLayoutItems = workbenchThreadStateLayoutItemsHistory.current;

const workbenchThreadStateLayoutThreadItemsV1 = defineTable("workbench_thread_state_layout_thread_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("thread").notNull().default("thread"),
  thread_id: text().notNull().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutThreadItemsHistory = initialHistory(workbenchThreadStateLayoutThreadItemsV1);
export const workbenchThreadStateLayoutThreadItems = workbenchThreadStateLayoutThreadItemsHistory.current;

const workbenchThreadStateLayoutDraftItemsV1 = defineTable("workbench_thread_state_layout_draft_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("draft").notNull().default("draft"),
  draft_id: text().notNull().references("workbench_thread_state_drafts", "draft_id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutDraftItemsHistory = initialHistory(workbenchThreadStateLayoutDraftItemsV1);
export const workbenchThreadStateLayoutDraftItems = workbenchThreadStateLayoutDraftItemsHistory.current;

const workbenchThreadStateLayoutFolderItemsV1 = defineTable("workbench_thread_state_layout_folder_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("folder").notNull().default("folder"),
  folder_id: text().notNull().references("workbench_thread_state_layout_folders", "folder_id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutFolderItemsHistory = initialHistory(workbenchThreadStateLayoutFolderItemsV1);
export const workbenchThreadStateLayoutFolderItems = workbenchThreadStateLayoutFolderItemsHistory.current;

const workbenchThreadStateLayoutRelationsV1 = defineTable("workbench_thread_state_layout_relations", {
  item_id: text().notNull(),
  related_item_id: text().notNull(),
  layout_id: text().notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  relation_kind: enumText("above", "below").notNull(),
  relation_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.relation_kind, table.relation_index]),
    foreignKey([table.item_id, table.layout_id, table.section], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.related_item_id, table.layout_id, table.section], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section"],
      onDelete: "CASCADE",
    }),
    check(sql`${table.item_id} <> ${table.related_item_id}`),
  ],
}));
const workbenchThreadStateLayoutRelationsHistory = initialHistory(workbenchThreadStateLayoutRelationsV1);
export const workbenchThreadStateLayoutRelations = workbenchThreadStateLayoutRelationsHistory.current;

const workbenchThreadStateFolderMembersV1 = defineTable("workbench_thread_state_folder_members", {
  folder_item_id: text().notNull(),
  folder_item_kind: enumText("folder").notNull().default("folder"),
  member_item_id: text().notNull(),
  member_item_kind: enumText("thread", "draft").notNull(),
  layout_id: text().notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  member_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.folder_item_id, table.member_index]),
    unique([table.layout_id, table.member_item_id]),
    foreignKey([table.folder_item_id, table.layout_id, table.section, table.folder_item_kind], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section", "item_kind"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.member_item_id, table.layout_id, table.section, table.member_item_kind], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section", "item_kind"],
      onDelete: "CASCADE",
    }),
    check(sql`${table.folder_item_id} <> ${table.member_item_id}`),
  ],
}));
const workbenchThreadStateFolderMembersHistory = initialHistory(workbenchThreadStateFolderMembersV1);
export const workbenchThreadStateFolderMembers = workbenchThreadStateFolderMembersHistory.current;

const workbenchThreadStatePinnedImportsV1 = defineTable("workbench_thread_state_pinned_imports", {
  project_id: text().primaryKey(),
  layout_id: text().notNull().references("workbench_thread_state_layouts", "id", { onDelete: "CASCADE" }),
});
const workbenchThreadStatePinnedImportsHistory = initialHistory(workbenchThreadStatePinnedImportsV1);
export const workbenchThreadStatePinnedImports = workbenchThreadStatePinnedImportsHistory.current;

const workbenchThreadStateQuestionnairesV1 = defineTable("workbench_thread_state_questionnaires", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  state: enumText("pending", "answered").notNull(),
  provider_turn_id: text(),
  provider_item_id: text(),
  request_key: text().notNull(),
  request_id: text().notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  submit_label: text().notNull(),
  insert_after_item_id: text(),
  insert_after_item_index: integer().nonNegative(),
  resolved_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.id, table.state]),
    unique([table.thread_id, table.request_key]),
    check(sql`
      (${table.state} = ${literal("pending")} AND ${table.resolved_at} IS NULL)
      OR (${table.state} = ${literal("answered")} AND ${table.resolved_at} IS NOT NULL)
    `),
  ],
}));
const workbenchThreadStateQuestionnairesHistory = initialHistory(workbenchThreadStateQuestionnairesV1);
export const workbenchThreadStateQuestionnaires = workbenchThreadStateQuestionnairesHistory.current;

const workbenchThreadStateQuestionnaireQuestionsV1 = defineTable("workbench_thread_state_questionnaire_questions", {
  questionnaire_id: text().notNull().references("workbench_thread_state_questionnaires", "id", { onDelete: "CASCADE" }),
  question_index: integer().notNull().nonNegative(),
  question_id: text().notNull(),
  header: text().notNull(),
  question: text().notNull(),
  allow_other: booleanInteger().notNull(),
  is_secret: booleanInteger().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_index]),
    unique([table.questionnaire_id, table.question_id]),
  ],
}));
const workbenchThreadStateQuestionnaireQuestionsHistory = initialHistory(workbenchThreadStateQuestionnaireQuestionsV1);
export const workbenchThreadStateQuestionnaireQuestions = workbenchThreadStateQuestionnaireQuestionsHistory.current;

const workbenchThreadStateQuestionnaireOptionsV1 = defineTable("workbench_thread_state_questionnaire_options", {
  questionnaire_id: text().notNull(),
  question_index: integer().notNull(),
  option_index: integer().notNull().nonNegative(),
  label: text().notNull(),
  description: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_index, table.option_index]),
    foreignKey([table.questionnaire_id, table.question_index], {
      table: "workbench_thread_state_questionnaire_questions",
      columns: ["questionnaire_id", "question_index"],
      onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadStateQuestionnaireOptionsHistory = initialHistory(workbenchThreadStateQuestionnaireOptionsV1);
export const workbenchThreadStateQuestionnaireOptions = workbenchThreadStateQuestionnaireOptionsHistory.current;

const workbenchThreadStateQuestionnaireAnswersV1 = defineTable("workbench_thread_state_questionnaire_answers", {
  questionnaire_id: text().notNull(),
  questionnaire_state: enumText("answered").notNull().default("answered"),
  question_id: text().notNull(),
  answer_index: integer().notNull().nonNegative(),
  answer: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_id, table.answer_index]),
    foreignKey([table.questionnaire_id, table.questionnaire_state], {
      table: "workbench_thread_state_questionnaires",
      columns: ["id", "state"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.questionnaire_id, table.question_id], {
      table: "workbench_thread_state_questionnaire_questions",
      columns: ["questionnaire_id", "question_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadStateQuestionnaireAnswersHistory = initialHistory(workbenchThreadStateQuestionnaireAnswersV1);
export const workbenchThreadStateQuestionnaireAnswers = workbenchThreadStateQuestionnaireAnswersHistory.current;

export const threadStateRelationalTables = Object.freeze({
  workbenchThreadStateProjectionStatus,
  workbenchThreadStateThreads,
  workbenchThreadStateProviderIdentities,
  workbenchThreadStateLifecycles,
  workbenchThreadStateSubagents,
  workbenchThreadStateRetention,
  workbenchThreadStateProfiles,
  workbenchThreadStateProjectProfiles,
  workbenchThreadStateSnoozeDependencies,
  workbenchThreadStateDrafts,
  workbenchThreadStateDraftAttachments,
  workbenchThreadStateLayouts,
  workbenchThreadStateProjectLayouts,
  workbenchThreadStateGlobalLayouts,
  workbenchThreadStateLayoutFolders,
  workbenchThreadStateLayoutItems,
  workbenchThreadStateLayoutThreadItems,
  workbenchThreadStateLayoutDraftItems,
  workbenchThreadStateLayoutFolderItems,
  workbenchThreadStateLayoutRelations,
  workbenchThreadStateFolderMembers,
  workbenchThreadStatePinnedImports,
  workbenchThreadStateQuestionnaires,
  workbenchThreadStateQuestionnaireQuestions,
  workbenchThreadStateQuestionnaireOptions,
  workbenchThreadStateQuestionnaireAnswers,
});

export const threadStateTables = Object.freeze({
  workbenchThreadStateGlobals,
  workbenchThreadStateProjects,
  ...threadStateRelationalTables,
});

export type ThreadStateSchemaRows = {
  [Name in keyof typeof threadStateTables]: SelectRow<(typeof threadStateTables)[Name]>;
};

export const threadStateSchemaHistory = defineSubsystemHistory([
  workbenchThreadStateProjectsHistory,
  workbenchThreadStateGlobalsHistory,
  workbenchThreadStateProjectionStatusHistory,
  workbenchThreadStateThreadsHistory,
  workbenchThreadStateProviderIdentitiesHistory,
  workbenchThreadStateLifecyclesHistory,
  workbenchThreadStateSubagentsHistory,
  workbenchThreadStateRetentionHistory,
  workbenchThreadStateProfilesHistory,
  workbenchThreadStateProjectProfilesHistory,
  workbenchThreadStateSnoozeDependenciesHistory,
  workbenchThreadStateDraftsHistory,
  workbenchThreadStateDraftAttachmentsHistory,
  workbenchThreadStateLayoutsHistory,
  workbenchThreadStateProjectLayoutsHistory,
  workbenchThreadStateGlobalLayoutsHistory,
  workbenchThreadStateLayoutFoldersHistory,
  workbenchThreadStateLayoutItemsHistory,
  workbenchThreadStateLayoutThreadItemsHistory,
  workbenchThreadStateLayoutDraftItemsHistory,
  workbenchThreadStateLayoutFolderItemsHistory,
  workbenchThreadStateLayoutRelationsHistory,
  workbenchThreadStateFolderMembersHistory,
  workbenchThreadStatePinnedImportsHistory,
  workbenchThreadStateQuestionnairesHistory,
  workbenchThreadStateQuestionnaireQuestionsHistory,
  workbenchThreadStateQuestionnaireOptionsHistory,
  workbenchThreadStateQuestionnaireAnswersHistory,
]);
