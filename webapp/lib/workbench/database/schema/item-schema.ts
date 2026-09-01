/*
 * threadItems: current canonical thread item table. Keywords: database, schema, item.
 * threadItemUserMessages: current user-message augmentation table. Keywords: database, schema, user-message.
 * threadUserMessageParts: current ordered user-message part table. Keywords: database, schema, user-message.
 * threadItemAssistantMessages: current assistant-message augmentation table. Keywords: database, schema, assistant-message.
 * threadItemPlans: current plan augmentation table. Keywords: database, schema, plan.
 * threadItemReasoning: current reasoning augmentation table. Keywords: database, schema, reasoning.
 * threadReasoningSections: current ordered reasoning section table. Keywords: database, schema, reasoning.
 * threadItemFileChanges: current file-change augmentation table. Keywords: database, schema, file-change.
 * threadFileChanges: current ordered file change table. Keywords: database, schema, file-change.
 * threadItemContextCompactions: current context-compaction augmentation table. Keywords: database, schema, compaction.
 * threadItemUnknown: current opaque unknown-item augmentation table. Keywords: database, schema, unknown.
 * threadItemTimelines/threadItemTimelineAliases: optional semantic item timing and alias augmentations. Keywords: database, schema, timeline, alias.
 * itemTables: current item table inventory. Keywords: database, schema, item.
 * ItemSchemaRows: selected row types for current item tables. Keywords: database, schema, types.
 * itemSchemaHistory: private item table histories. Keywords: database, schema, history.
 */
import {
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
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table, migration: createTable(table) })],
    current: table,
  });
}

const threadItemsV1 = defineTable("thread_items", {
  id: integer().primaryKey({ autoincrement: true }),
  source_id: text().notNull(),
  thread_id: text().notNull(),
  turn_id: text().notNull(),
  item_position: integer().notNull().nonNegative(),
  type: enumText(
    "userMessage",
    "assistantMessage",
    "plan",
    "reasoning",
    "operation",
    "fileChange",
    "webSearch",
    "questionnaire",
    "approval",
    "contextCompaction",
    "unknown",
  ).notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => ({
  constraints: [
    unique([table.turn_id, table.item_position]),
    unique([table.thread_id, table.source_id]),
    unique([table.id, table.type]),
    unique([table.id, table.thread_id, table.type]),
    unique([table.id, table.thread_id, table.turn_id]),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns",
      columns: ["id", "thread_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemsHistory = initialHistory(threadItemsV1);
export const threadItems = threadItemsHistory.current;

const threadItemUserMessagesV1 = defineTable("thread_item_user_messages", {
  item_id: integer().primaryKey(),
  item_type: enumText("userMessage").notNull().default("userMessage"),
  delivery_state: enumText("delivered", "interrupted", "failed").notNull(),
  client_id: text(),
  error_text: text(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.delivery_state} = ${literal("failed")} AND ${table.error_text} IS NOT NULL)
      OR (${table.delivery_state} <> ${literal("failed")} AND ${table.error_text} IS NULL)
    `),
    foreignKey([table.item_id, table.item_type], {
      table: "thread_items",
      columns: ["id", "type"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemUserMessagesHistory = initialHistory(threadItemUserMessagesV1);
export const threadItemUserMessages = threadItemUserMessagesHistory.current;

const threadUserMessagePartsV1 = defineTable("thread_user_message_parts", {
  item_id: integer().notNull().references("thread_item_user_messages", "item_id", { onDelete: "CASCADE" }),
  part_index: integer().notNull(),
  part_type: enumText("text", "image", "localImage", "skill", "mention").notNull(),
  text: text(),
  url: text(),
  path: text(),
  name: text(),
  image_detail: enumText("auto", "low", "high", "original"),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.part_index]),
    check(sql`
      (${table.part_type} = ${literal("text")} AND ${table.text} IS NOT NULL AND ${table.url} IS NULL AND ${table.path} IS NULL AND ${table.name} IS NULL AND ${table.image_detail} IS NULL)
      OR (${table.part_type} = ${literal("image")} AND ${table.text} IS NULL AND ${table.url} IS NOT NULL AND ${table.path} IS NULL AND ${table.name} IS NULL)
      OR (${table.part_type} = ${literal("localImage")} AND ${table.text} IS NULL AND ${table.url} IS NULL AND ${table.path} IS NOT NULL AND ${table.name} IS NULL)
      OR (${table.part_type} IN (${literal("skill")}, ${literal("mention")}) AND ${table.text} IS NULL AND ${table.url} IS NULL AND ${table.path} IS NOT NULL AND ${table.name} IS NOT NULL AND ${table.image_detail} IS NULL)
    `),
  ],
}));
const threadUserMessagePartsHistory = initialHistory(threadUserMessagePartsV1);
export const threadUserMessageParts = threadUserMessagePartsHistory.current;

const threadItemAssistantMessagesV1 = defineTable("thread_item_assistant_messages", {
  item_id: integer().primaryKey(),
  item_type: enumText("assistantMessage").notNull().default("assistantMessage"),
  state: enumText("streaming", "completed", "interrupted").notNull(),
  phase: enumText("commentary", "finalAnswer", "unknown").notNull(),
  text: text().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadItemAssistantMessagesHistory = initialHistory(threadItemAssistantMessagesV1);
export const threadItemAssistantMessages = threadItemAssistantMessagesHistory.current;

const threadItemPlansV1 = defineTable("thread_item_plans", {
  item_id: integer().primaryKey(),
  item_type: enumText("plan").notNull().default("plan"),
  text: text().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadItemPlansHistory = initialHistory(threadItemPlansV1);
export const threadItemPlans = threadItemPlansHistory.current;

const threadItemReasoningV1 = defineTable("thread_item_reasoning", {
  item_id: integer().primaryKey(),
  item_type: enumText("reasoning").notNull().default("reasoning"),
  state: enumText("streaming", "completed", "interrupted").notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadItemReasoningHistory = initialHistory(threadItemReasoningV1);
export const threadItemReasoning = threadItemReasoningHistory.current;

const threadReasoningSectionsV1 = defineTable("thread_reasoning_sections", {
  item_id: integer().notNull().references("thread_item_reasoning", "item_id", { onDelete: "CASCADE" }),
  section_index: integer().notNull(),
  text: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.section_index])],
}));
const threadReasoningSectionsHistory = initialHistory(threadReasoningSectionsV1);
export const threadReasoningSections = threadReasoningSectionsHistory.current;

const threadItemFileChangesV1 = defineTable("thread_item_file_changes", {
  item_id: integer().primaryKey(),
  item_type: enumText("fileChange").notNull().default("fileChange"),
  state: enumText("inProgress", "completed", "failed", "declined").notNull(),
  error_text: text(),
  workbench_failure_kind: enumText("unclaimed"),
}, (table) => ({
  constraints: [
    check(sql`${table.workbench_failure_kind} IS NULL OR ${table.state} = ${literal("failed")}`),
    foreignKey([table.item_id, table.item_type], {
      table: "thread_items",
      columns: ["id", "type"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemFileChangesHistory = initialHistory(threadItemFileChangesV1);
export const threadItemFileChanges = threadItemFileChangesHistory.current;

const threadFileChangesV1 = defineTable("thread_file_changes", {
  item_id: integer().notNull().references("thread_item_file_changes", "item_id", { onDelete: "CASCADE" }),
  change_index: integer().notNull(),
  path: text().notNull(),
  change_kind: enumText("add", "delete", "update").notNull(),
  diff: text().notNull(),
  move_path: text(),
  workbench_additions: integer().nonNegative(),
  workbench_deletions: integer().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.change_index]),
    check(sql`${table.move_path} IS NULL OR ${table.change_kind} = ${literal("update")}`),
    check(sql`
      (${table.workbench_additions} IS NULL AND ${table.workbench_deletions} IS NULL)
      OR (${table.workbench_additions} >= ${literal(0)} AND ${table.workbench_deletions} >= ${literal(0)})
    `),
  ],
}));
const threadFileChangesHistory = initialHistory(threadFileChangesV1);
export const threadFileChanges = threadFileChangesHistory.current;

const threadItemContextCompactionsV1 = defineTable("thread_item_context_compactions", {
  item_id: integer().primaryKey(),
  item_type: enumText("contextCompaction").notNull().default("contextCompaction"),
  state: enumText("inProgress", "completed", "failed").notNull(),
  error_text: text(),
}, (table) => ({
  constraints: [
    check(sql`(${table.state} = ${literal("failed")} AND ${table.error_text} IS NOT NULL) OR ${table.state} <> ${literal("failed")}`),
    foreignKey([table.item_id, table.item_type], {
      table: "thread_items",
      columns: ["id", "type"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemContextCompactionsHistory = initialHistory(threadItemContextCompactionsV1);
export const threadItemContextCompactions = threadItemContextCompactionsHistory.current;

const threadItemUnknownV1 = defineTable("thread_item_unknown", {
  item_id: integer().primaryKey(),
  item_type: enumText("unknown").notNull().default("unknown"),
  native_type: text().notNull(),
  safe_json: jsonText().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadItemUnknownHistory = initialHistory(threadItemUnknownV1);
export const threadItemUnknown = threadItemUnknownHistory.current;

const threadItemTimelinesV1 = defineTable("thread_item_timelines", {
  item_id: integer().primaryKey().references("thread_items", "id", { onDelete: "CASCADE" }),
  first_seen_at: integer(),
  last_seen_at: integer(),
  started_at: integer(),
  completed_at: integer(),
});
const threadItemTimelinesHistory = initialHistory(threadItemTimelinesV1);
export const threadItemTimelines = threadItemTimelinesHistory.current;

const threadItemTimelineAliasesV1 = defineTable("thread_item_timeline_aliases", {
  item_id: integer().notNull().references("thread_item_timelines", "item_id", { onDelete: "CASCADE" }),
  alias: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.alias])],
}));
const threadItemTimelineAliasesHistory = initialHistory(threadItemTimelineAliasesV1);
export const threadItemTimelineAliases = threadItemTimelineAliasesHistory.current;

export const itemTables = Object.freeze({
  threadItems,
  threadItemTimelines,
  threadItemTimelineAliases,
  threadItemUserMessages,
  threadUserMessageParts,
  threadItemAssistantMessages,
  threadItemPlans,
  threadItemReasoning,
  threadReasoningSections,
  threadItemFileChanges,
  threadFileChanges,
  threadItemContextCompactions,
  threadItemUnknown,
});

export type ItemSchemaRows = {
  [Name in keyof typeof itemTables]: SelectRow<(typeof itemTables)[Name]>;
};

export const itemSchemaHistory = defineSubsystemHistory([
  threadItemsHistory,
  threadItemTimelinesHistory,
  threadItemTimelineAliasesHistory,
  threadItemUserMessagesHistory,
  threadUserMessagePartsHistory,
  threadItemAssistantMessagesHistory,
  threadItemPlansHistory,
  threadItemReasoningHistory,
  threadReasoningSectionsHistory,
  threadItemFileChangesHistory,
  threadFileChangesHistory,
  threadItemContextCompactionsHistory,
  threadItemUnknownHistory,
]);
