/*
 * Keywords: database, interaction, questions, approvals, history.
 * threadItemWebSearches: current web-search item augmentation table. Keywords: database, schema, web-search.
 * threadWebSearchQueries: current ordered web-search query table. Keywords: database, schema, web-search.
 * threadWebSearchResults: current ordered opaque web-search result table. Keywords: database, schema, web-search.
 * threadItemInteractions: current settled interaction owner table. Keywords: database, schema, interaction.
 * threadInteractionQuestions: current ordered interaction question table. Keywords: database, schema, questionnaire.
 * threadInteractionOptions: current ordered interaction option table. Keywords: database, schema, questionnaire.
 * threadInteractionAnswers: current ordered settled answer table. Keywords: database, schema, questionnaire.
 * threadApprovalCommandContexts: current approval command context table. Keywords: database, schema, approval.
 * threadApprovalCommandActions: current ordered approval command action table. Keywords: database, schema, approval.
 * interactionTables: current interaction table inventory. Keywords: database, schema, interaction.
 * InteractionSchemaRows: selected row types for current interaction tables. Keywords: database, schema, types.
 * interactionSchemaHistory: private interaction table histories. Keywords: database, schema, history.
 */
import databaseReleases from "./releases.ts";
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  evolveTable,
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
} from "../../../database/schema/schema-definition.ts";
import { addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "../../../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table, migration: createTable(table) })],
    current: table,
  });
}

const threadItemWebSearchesV1 = defineTable("thread_item_web_searches", {
  item_id: integer().primaryKey(),
  item_type: enumText("webSearch").notNull().default("webSearch"),
  state: enumText("inProgress", "completed", "failed").notNull(),
  query: text().notNull(),
  action_kind: enumText("none", "search", "openPage", "findInPage", "other").notNull(),
  action_query: text(),
  url: text(),
  pattern: text(),
  error_text: text(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadItemWebSearchesHistory = initialHistory(threadItemWebSearchesV1);
export const threadItemWebSearches = threadItemWebSearchesHistory.current;

const threadWebSearchQueriesV1 = defineTable("thread_web_search_queries", {
  item_id: integer().notNull().references("thread_item_web_searches", "item_id", { onDelete: "CASCADE" }),
  query_index: integer().notNull(),
  query: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.query_index])],
}));
const threadWebSearchQueriesHistory = initialHistory(threadWebSearchQueriesV1);
export const threadWebSearchQueries = threadWebSearchQueriesHistory.current;

const threadWebSearchResultsV1 = defineTable("thread_web_search_results", {
  item_id: integer().notNull().references("thread_item_web_searches", "item_id", { onDelete: "CASCADE" }),
  result_index: integer().notNull(),
  opaque_json: jsonText().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.result_index])],
}));
const threadWebSearchResultsHistory = initialHistory(threadWebSearchResultsV1);
export const threadWebSearchResults = threadWebSearchResultsHistory.current;

const threadItemInteractionsV1 = defineTable("thread_item_interactions", {
  item_id: integer().primaryKey(),
  item_type: enumText("questionnaire", "approval").notNull(),
  thread_id: text().notNull(),
  request_key: text().notNull(),
  request_id: text().notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  submit_label: text().notNull(),
  state: enumText("answered", "cancelled", "failed").notNull(),
  error_text: text(),
  resolved_at: integer().notNull(),
}, (table) => ({
  constraints: [
    foreignKey([table.item_id, table.thread_id, table.item_type], {
      table: "thread_items",
      columns: ["id", "thread_id", "type"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemInteractionsHistory = initialHistory(threadItemInteractionsV1);
export const threadItemInteractions = threadItemInteractionsHistory.current;

const threadInteractionQuestionsV1 = defineTable("thread_interaction_questions", {
  item_id: integer().notNull().references("thread_item_interactions", "item_id", { onDelete: "CASCADE" }),
  question_index: integer().notNull(),
  question_id: text().notNull(),
  header: text().notNull(),
  question: text().notNull(),
  allow_other: booleanInteger().notNull(),
  is_secret: booleanInteger().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.question_index]),
    unique([table.item_id, table.question_id]),
  ],
}));
const threadInteractionQuestionsHistory = initialHistory(threadInteractionQuestionsV1);
export const threadInteractionQuestions = threadInteractionQuestionsHistory.current;

const threadInteractionOptionsV1 = defineTable("thread_interaction_options", {
  item_id: integer().notNull(),
  question_index: integer().notNull(),
  option_index: integer().notNull(),
  label: text().notNull(),
  description: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.question_index, table.option_index]),
    foreignKey([table.item_id, table.question_index], {
      table: "thread_interaction_questions",
      columns: ["item_id", "question_index"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadInteractionOptionsHistory = initialHistory(threadInteractionOptionsV1);
export const threadInteractionOptions = threadInteractionOptionsHistory.current;

const threadInteractionAnswersV1 = defineTable("thread_interaction_answers", {
  item_id: integer().notNull().references("thread_item_interactions", "item_id", { onDelete: "CASCADE" }),
  question_id: text().notNull(),
  answer_index: integer().notNull(),
  answer: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.question_id, table.answer_index]),
    foreignKey([table.item_id, table.question_id], {
      table: "thread_interaction_questions",
      columns: ["item_id", "question_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadInteractionAnswersHistory = initialHistory(threadInteractionAnswersV1);
export const threadInteractionAnswers = threadInteractionAnswersHistory.current;

const threadApprovalCommandContextsV1 = defineTable("thread_approval_command_contexts", {
  item_id: integer().primaryKey(),
  item_type: enumText("approval").notNull().default("approval"),
  command: text().notNull(),
  cwd: text().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type], {
    table: "thread_items",
    columns: ["id", "type"],
    onDelete: "CASCADE",
  })],
}));
const threadApprovalCommandContextsV2 = evolveTable(threadApprovalCommandContextsV1, {
  add: { justification: text(), network_target: text() },
});
const threadApprovalCommandContextsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadApprovalCommandContextsV1, migration: createTable(threadApprovalCommandContextsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.commandApprovals.version,
      table: threadApprovalCommandContextsV2,
      migration: addColumns({ from: threadApprovalCommandContextsV1, to: threadApprovalCommandContextsV2, columns: ["justification", "network_target"] }),
    }),
  ],
  current: threadApprovalCommandContextsV2,
});
export const threadApprovalCommandContexts = threadApprovalCommandContextsHistory.current;

const threadApprovalCommandActionsV1 = defineTable("thread_approval_command_actions", {
  item_id: integer().notNull().references("thread_approval_command_contexts", "item_id", { onDelete: "CASCADE" }),
  action_index: integer().notNull().nonNegative(),
  action_kind: enumText("read", "listFiles", "search", "unknown").notNull(),
  command: text().notNull(),
  name: text(),
  path: text(),
  query: text(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.action_index]),
    check(sql`
      (${table.action_kind} = ${literal("read")} AND ${table.name} IS NOT NULL AND ${table.path} IS NOT NULL AND ${table.query} IS NULL)
      OR (${table.action_kind} = ${literal("listFiles")} AND ${table.name} IS NULL AND ${table.query} IS NULL)
      OR (${table.action_kind} = ${literal("search")} AND ${table.name} IS NULL)
      OR (${table.action_kind} = ${literal("unknown")} AND ${table.name} IS NULL AND ${table.path} IS NULL AND ${table.query} IS NULL)
    `),
  ],
}));
const threadApprovalCommandActionsHistory = initialHistory(threadApprovalCommandActionsV1);
export const threadApprovalCommandActions = threadApprovalCommandActionsHistory.current;

export const interactionTables = Object.freeze({
  threadItemWebSearches,
  threadWebSearchQueries,
  threadWebSearchResults,
  threadItemInteractions,
  threadInteractionQuestions,
  threadInteractionOptions,
  threadInteractionAnswers,
  threadApprovalCommandContexts,
  threadApprovalCommandActions,
});

export type InteractionSchemaRows = {
  [Name in keyof typeof interactionTables]: SelectRow<(typeof interactionTables)[Name]>;
};

export const interactionSchemaHistory = defineSubsystemHistory([
  threadItemWebSearchesHistory,
  threadWebSearchQueriesHistory,
  threadWebSearchResultsHistory,
  threadItemInteractionsHistory,
  threadInteractionQuestionsHistory,
  threadInteractionOptionsHistory,
  threadInteractionAnswersHistory,
  threadApprovalCommandContextsHistory,
  threadApprovalCommandActionsHistory,
]);
