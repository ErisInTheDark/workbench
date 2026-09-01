/*
 * transcriptNativeRecords: current provider-native evidence table. Keywords: database, schema, evidence.
 * transcriptAssets: current content-addressed asset table. Keywords: database, schema, asset.
 * threadBrowseEntries: current durable Browse fact table. Keywords: database, schema, browse.
 * transcriptAssetRefs: current thread or item asset reference table. Keywords: database, schema, asset.
 * transcriptCaptureGaps: current transcript capture gap table. Keywords: database, schema, evidence.
 * evidenceTables: current evidence table inventory. Keywords: database, schema, evidence.
 * EvidenceSchemaRows: selected row types for current evidence tables. Keywords: database, schema, types.
 * evidenceSchemaHistory: private evidence table histories. Keywords: database, schema, history.
 */
import {
  check,
  defineTable,
  enumText,
  foreignKey,
  index,
  integer,
  jsonText,
  literal,
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

const transcriptNativeRecordsV1 = defineTable("transcript_native_records", {
  record_sequence: integer().primaryKey({ autoincrement: true }),
  link_kind: enumText("orphan", "turn", "item").notNull(),
  thread_id: text(),
  turn_id: text(),
  item_id: integer(),
  harness_id: text().notNull().references("workbench_harnesses", "id"),
  native_location: text().notNull(),
  native_thread_id: text(),
  record_kind: enumText("request", "response", "event", "snapshot").notNull(),
  orphan_native_turn_id: text(),
  native_item_id: text(),
  native_event_id: text(),
  client_id: text(),
  native_sequence: text(),
  payload_json: jsonText().notNull(),
  recorded_at: integer().notNull(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.link_kind} = ${literal("orphan")} AND ${table.thread_id} IS NULL AND ${table.turn_id} IS NULL AND ${table.item_id} IS NULL)
      OR (${table.link_kind} = ${literal("turn")} AND ${table.thread_id} IS NOT NULL AND ${table.turn_id} IS NOT NULL AND ${table.item_id} IS NULL AND ${table.native_thread_id} IS NOT NULL AND ${table.orphan_native_turn_id} IS NULL)
      OR (${table.link_kind} = ${literal("item")} AND ${table.thread_id} IS NOT NULL AND ${table.turn_id} IS NOT NULL AND ${table.item_id} IS NOT NULL AND ${table.native_thread_id} IS NOT NULL AND ${table.orphan_native_turn_id} IS NULL)
    `),
    foreignKey([table.turn_id, table.thread_id, table.harness_id, table.native_location, table.native_thread_id], {
      table: "thread_turns",
      columns: ["id", "thread_id", "harness_id", "native_location", "native_thread_id"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.item_id, table.thread_id, table.turn_id], {
      table: "thread_items",
      columns: ["id", "thread_id", "turn_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const transcriptNativeRecordsHistory = initialHistory(transcriptNativeRecordsV1);
export const transcriptNativeRecords = transcriptNativeRecordsHistory.current;

const transcriptAssetsV1 = defineTable("transcript_assets", {
  digest: text().primaryKey(),
  mime_type: text().notNull(),
  byte_length: integer().notNull().nonNegative(),
  storage_key: text().notNull().unique(),
  created_at: integer().notNull(),
});
const transcriptAssetsHistory = initialHistory(transcriptAssetsV1);
export const transcriptAssets = transcriptAssetsHistory.current;

const threadBrowseEntriesV1 = defineTable("thread_browse_entries", {
  entry_key: text().primaryKey(),
  item_id: integer().notNull().references("thread_item_operations", "item_id", { onDelete: "CASCADE" }),
  action_index: integer().notNull(),
  action: text().notNull(),
  state: enumText("queued", "inProgress", "completed", "failed").notNull(),
  session_name: text(),
  detail_kind: enumText("error", "result", "text"),
  detail_label: text(),
  detail_text: text(),
  duration_ms: integer().nonNegative(),
  asset_digest: text().references("transcript_assets", "digest"),
  recorded_at: integer().notNull(),
}, (table) => ({
  constraints: [unique([table.item_id, table.action_index])],
}));
const threadBrowseEntriesHistory = initialHistory(threadBrowseEntriesV1);
export const threadBrowseEntries = threadBrowseEntriesHistory.current;

const transcriptAssetRefsV1 = defineTable("transcript_asset_refs", {
  id: text().primaryKey(),
  thread_id: text().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  item_id: integer().references("thread_items", "id", { onDelete: "CASCADE" }),
  owner_kind: enumText("thread", "item").notNull(),
  role: text().notNull(),
  ref_index: integer().notNull(),
  asset_digest: text().notNull().references("transcript_assets", "digest"),
  created_at: integer().notNull(),
}, (table) => ({
  constraints: [check(sql`
    (${table.owner_kind} = ${literal("thread")} AND ${table.thread_id} IS NOT NULL AND ${table.item_id} IS NULL)
    OR (${table.owner_kind} = ${literal("item")} AND ${table.thread_id} IS NULL AND ${table.item_id} IS NOT NULL)
  `)],
  indexes: [
    index("transcript_asset_refs_thread_idx", [table.thread_id, table.role, table.ref_index], {
      unique: true,
      where: sql`${table.owner_kind} = ${literal("thread")}`,
    }),
    index("transcript_asset_refs_item_idx", [table.item_id, table.role, table.ref_index], {
      unique: true,
      where: sql`${table.owner_kind} = ${literal("item")}`,
    }),
  ],
}));
const transcriptAssetRefsHistory = initialHistory(transcriptAssetRefsV1);
export const transcriptAssetRefs = transcriptAssetRefsHistory.current;

const transcriptCaptureGapsV1 = defineTable("transcript_capture_gaps", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  turn_id: text(),
  state: enumText("open", "reconciled", "unrecoverable").notNull(),
  reason: text().notNull(),
  opened_at: integer().notNull(),
  closed_at: integer(),
  error_text: text(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.state} = ${literal("open")} AND ${table.closed_at} IS NULL)
      OR (${table.state} IN (${literal("reconciled")}, ${literal("unrecoverable")}) AND ${table.closed_at} IS NOT NULL)
    `),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns",
      columns: ["id", "thread_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const transcriptCaptureGapsHistory = initialHistory(transcriptCaptureGapsV1);
export const transcriptCaptureGaps = transcriptCaptureGapsHistory.current;

export const evidenceTables = Object.freeze({
  transcriptNativeRecords,
  transcriptAssets,
  threadBrowseEntries,
  transcriptAssetRefs,
  transcriptCaptureGaps,
});

export type EvidenceSchemaRows = {
  [Name in keyof typeof evidenceTables]: SelectRow<(typeof evidenceTables)[Name]>;
};

export const evidenceSchemaHistory = defineSubsystemHistory([
  transcriptNativeRecordsHistory,
  transcriptAssetsHistory,
  threadBrowseEntriesHistory,
  transcriptAssetRefsHistory,
  transcriptCaptureGapsHistory,
]);
