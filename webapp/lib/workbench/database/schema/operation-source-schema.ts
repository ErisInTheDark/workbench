/*
 * threadItemOperations: current operation source root table. Keywords: database, schema, operation.
 * threadOperationProcessSources: current process operation source table. Keywords: database, schema, process.
 * threadProcessCommandActions: current ordered process command action table. Keywords: database, schema, command.
 * threadOperationToolSources: current tool operation source table. Keywords: database, schema, tool.
 * threadOperationCallableToolSources: current callable tool source table. Keywords: database, schema, callable.
 * threadCallableDynamicContent: current dynamic callable content table. Keywords: database, schema, callable.
 * threadCallableMcpResults: current MCP result owner table. Keywords: database, schema, mcp.
 * threadCallableMcpResultContent: current ordered MCP result content table. Keywords: database, schema, mcp.
 * threadOperationCollaborationToolSources: current collaboration source table. Keywords: database, schema, collaboration.
 * threadCollaborationReceivers: current ordered collaboration receiver table. Keywords: database, schema, collaboration.
 * threadCollaborationAgentStates: current collaboration agent state table. Keywords: database, schema, collaboration.
 * operationSourceTables: current operation source table inventory. Keywords: database, schema, operation.
 * OperationSourceSchemaRows: selected row types for current operation source tables. Keywords: database, schema, types.
 * operationSourceSchemaHistory: private operation source table histories. Keywords: database, schema, history.
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
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table, migration: createTable(table) })],
    current: table,
  });
}

const threadItemOperationsV1 = defineTable("thread_item_operations", {
  item_id: integer().primaryKey(),
  item_type: enumText("operation").notNull().default("operation"),
  source_kind: enumText("process", "tool").notNull(),
  source_revision: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.item_id, table.source_revision]),
    unique([table.item_id, table.item_type, table.source_kind, table.source_revision]),
    foreignKey([table.item_id, table.item_type], {
      table: "thread_items",
      columns: ["id", "type"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadItemOperationsHistory = initialHistory(threadItemOperationsV1);
export const threadItemOperations = threadItemOperationsHistory.current;

const threadOperationProcessSourcesV1 = defineTable("thread_operation_process_sources", {
  item_id: integer().primaryKey(),
  item_type: enumText("operation").notNull().default("operation"),
  source_kind: enumText("process").notNull().default("process"),
  source_revision: integer().notNull(),
  state: enumText("queued", "inProgress", "completed", "failed", "declined", "timedOut").notNull(),
  command: text().notNull(),
  cwd: text().notNull(),
  process_id: text(),
  plugin_id: text(),
  script_path: text(),
  output_text: text(),
  exit_code: integer(),
  duration_ms: integer().nonNegative(),
  error_text: text(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_type, table.source_kind, table.source_revision], {
    table: "thread_item_operations",
    columns: ["item_id", "item_type", "source_kind", "source_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationProcessSourcesHistory = initialHistory(threadOperationProcessSourcesV1);
export const threadOperationProcessSources = threadOperationProcessSourcesHistory.current;

const threadProcessCommandActionsV1 = defineTable("thread_process_command_actions", {
  item_id: integer().notNull().references("thread_operation_process_sources", "item_id", { onDelete: "CASCADE" }),
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
const threadProcessCommandActionsHistory = initialHistory(threadProcessCommandActionsV1);
export const threadProcessCommandActions = threadProcessCommandActionsHistory.current;

const threadOperationToolSourcesV1 = defineTable("thread_operation_tool_sources", {
  item_id: integer().primaryKey(),
  item_type: enumText("operation").notNull().default("operation"),
  source_kind: enumText("tool").notNull().default("tool"),
  source_revision: integer().notNull(),
  tool_kind: enumText("callable", "collaboration").notNull(),
  state: enumText("inProgress", "completed", "failed").notNull(),
  tool_name: text().notNull(),
  duration_ms: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.item_id, table.tool_kind, table.source_revision, table.state, table.tool_name]),
    foreignKey([table.item_id, table.item_type, table.source_kind, table.source_revision], {
      table: "thread_item_operations",
      columns: ["item_id", "item_type", "source_kind", "source_revision"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadOperationToolSourcesHistory = initialHistory(threadOperationToolSourcesV1);
export const threadOperationToolSources = threadOperationToolSourcesHistory.current;

const threadOperationCallableToolSourcesV1 = defineTable("thread_operation_callable_tool_sources", {
  item_id: integer().primaryKey(),
  tool_kind: enumText("callable").notNull().default("callable"),
  source_revision: integer().notNull(),
  state: enumText("inProgress", "completed", "failed").notNull(),
  tool_name: text().notNull(),
  callable_kind: enumText("mcp", "dynamic").notNull(),
  namespace: text(),
  server_name: text(),
  arguments_json: jsonText().notNull(),
  app_connector_id: text(),
  app_link_id: text(),
  app_resource_uri: text(),
  app_name: text(),
  app_action_name: text(),
  legacy_resource_uri: text(),
  plugin_id: text(),
  read_only_hint: booleanInteger(),
  success: booleanInteger(),
  error_text: text(),
}, (table) => ({
  constraints: [
    unique([table.item_id, table.source_revision, table.callable_kind]),
    check(sql`
      (${table.callable_kind} = ${literal("mcp")} AND ${table.namespace} IS NULL AND ${table.server_name} IS NOT NULL AND ${table.success} IS NULL)
      OR (${table.callable_kind} = ${literal("dynamic")} AND ${table.server_name} IS NULL AND ${table.app_connector_id} IS NULL AND ${table.app_link_id} IS NULL
        AND ${table.app_resource_uri} IS NULL AND ${table.app_name} IS NULL AND ${table.app_action_name} IS NULL
        AND ${table.legacy_resource_uri} IS NULL AND ${table.read_only_hint} IS NULL)
    `),
    foreignKey([table.item_id, table.tool_kind, table.source_revision, table.state, table.tool_name], {
      table: "thread_operation_tool_sources",
      columns: ["item_id", "tool_kind", "source_revision", "state", "tool_name"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadOperationCallableToolSourcesHistory = initialHistory(threadOperationCallableToolSourcesV1);
export const threadOperationCallableToolSources = threadOperationCallableToolSourcesHistory.current;

const threadCallableDynamicContentV1 = defineTable("thread_callable_dynamic_content", {
  item_id: integer().notNull(),
  content_index: integer().notNull(),
  source_revision: integer().notNull(),
  callable_kind: enumText("dynamic").notNull().default("dynamic"),
  content_kind: enumText("inputText", "inputImage", "inputAudio").notNull(),
  text: text(),
  url: text(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.content_index]),
    check(sql`
      (${table.content_kind} = ${literal("inputText")} AND ${table.text} IS NOT NULL AND ${table.url} IS NULL)
      OR (${table.content_kind} IN (${literal("inputImage")}, ${literal("inputAudio")}) AND ${table.text} IS NULL AND ${table.url} IS NOT NULL)
    `),
    foreignKey([table.item_id, table.source_revision, table.callable_kind], {
      table: "thread_operation_callable_tool_sources",
      columns: ["item_id", "source_revision", "callable_kind"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadCallableDynamicContentHistory = initialHistory(threadCallableDynamicContentV1);
export const threadCallableDynamicContent = threadCallableDynamicContentHistory.current;

const threadCallableMcpResultsV1 = defineTable("thread_callable_mcp_results", {
  item_id: integer().primaryKey(),
  source_revision: integer().notNull(),
  callable_kind: enumText("mcp").notNull().default("mcp"),
  structured_content_json: jsonText(),
  meta_json: jsonText(),
}, (table) => ({
  constraints: [
    unique([table.item_id, table.source_revision]),
    foreignKey([table.item_id, table.source_revision, table.callable_kind], {
      table: "thread_operation_callable_tool_sources",
      columns: ["item_id", "source_revision", "callable_kind"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadCallableMcpResultsHistory = initialHistory(threadCallableMcpResultsV1);
export const threadCallableMcpResults = threadCallableMcpResultsHistory.current;

const threadCallableMcpResultContentV1 = defineTable("thread_callable_mcp_result_content", {
  item_id: integer().notNull(),
  source_revision: integer().notNull(),
  content_index: integer().notNull(),
  content_kind: enumText("text", "opaque").notNull(),
  text: text(),
  opaque_json: jsonText(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.source_revision, table.content_index]),
    check(sql`
      (${table.content_kind} = ${literal("text")} AND ${table.text} IS NOT NULL AND ${table.opaque_json} IS NULL)
      OR (${table.content_kind} = ${literal("opaque")} AND ${table.text} IS NULL AND ${table.opaque_json} IS NOT NULL)
    `),
    foreignKey([table.item_id, table.source_revision], {
      table: "thread_callable_mcp_results",
      columns: ["item_id", "source_revision"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadCallableMcpResultContentHistory = initialHistory(threadCallableMcpResultContentV1);
export const threadCallableMcpResultContent = threadCallableMcpResultContentHistory.current;

const threadOperationCollaborationToolSourcesV1 = defineTable("thread_operation_collaboration_tool_sources", {
  item_id: integer().primaryKey(),
  tool_kind: enumText("collaboration").notNull().default("collaboration"),
  source_revision: integer().notNull(),
  state: enumText("inProgress", "completed", "failed").notNull(),
  tool_name: enumText("spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent").notNull(),
  sender_thread_id: text().notNull(),
  prompt: text(),
  model: text(),
  reasoning_effort: text(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.tool_kind, table.source_revision, table.state, table.tool_name], {
    table: "thread_operation_tool_sources",
    columns: ["item_id", "tool_kind", "source_revision", "state", "tool_name"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationCollaborationToolSourcesHistory = initialHistory(threadOperationCollaborationToolSourcesV1);
export const threadOperationCollaborationToolSources = threadOperationCollaborationToolSourcesHistory.current;

const threadCollaborationReceiversV1 = defineTable("thread_collaboration_receivers", {
  item_id: integer().notNull().references("thread_operation_collaboration_tool_sources", "item_id", { onDelete: "CASCADE" }),
  receiver_index: integer().notNull(),
  receiver_thread_id: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.receiver_index])],
}));
const threadCollaborationReceiversHistory = initialHistory(threadCollaborationReceiversV1);
export const threadCollaborationReceivers = threadCollaborationReceiversHistory.current;

const threadCollaborationAgentStatesV1 = defineTable("thread_collaboration_agent_states", {
  item_id: integer().notNull().references("thread_operation_collaboration_tool_sources", "item_id", { onDelete: "CASCADE" }),
  agent_thread_id: text().notNull(),
  status: enumText("pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound").notNull(),
  message: text(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.agent_thread_id])],
}));
const threadCollaborationAgentStatesHistory = initialHistory(threadCollaborationAgentStatesV1);
export const threadCollaborationAgentStates = threadCollaborationAgentStatesHistory.current;

export const operationSourceTables = Object.freeze({
  threadItemOperations,
  threadOperationProcessSources,
  threadProcessCommandActions,
  threadOperationToolSources,
  threadOperationCallableToolSources,
  threadCallableDynamicContent,
  threadCallableMcpResults,
  threadCallableMcpResultContent,
  threadOperationCollaborationToolSources,
  threadCollaborationReceivers,
  threadCollaborationAgentStates,
});

export type OperationSourceSchemaRows = {
  [Name in keyof typeof operationSourceTables]: SelectRow<(typeof operationSourceTables)[Name]>;
};

export const operationSourceSchemaHistory = defineSubsystemHistory([
  threadItemOperationsHistory,
  threadOperationProcessSourcesHistory,
  threadProcessCommandActionsHistory,
  threadOperationToolSourcesHistory,
  threadOperationCallableToolSourcesHistory,
  threadCallableDynamicContentHistory,
  threadCallableMcpResultsHistory,
  threadCallableMcpResultContentHistory,
  threadOperationCollaborationToolSourcesHistory,
  threadCollaborationReceiversHistory,
  threadCollaborationAgentStatesHistory,
]);
