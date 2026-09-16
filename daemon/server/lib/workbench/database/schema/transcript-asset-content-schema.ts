/*
 * Exports:
 * - transcriptAssetContent: daemon-only immutable image bytes.
 * - transcriptAssetAddresses: thread-owned compatibility image addresses.
 * - transcriptAssetContentSchemaHistory: asset content installation history.
 */
import { blob, defineTable, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const content = defineTable("transcript_asset_content", {
  digest: text().primaryKey().references("transcript_assets", "digest", { onDelete: "CASCADE" }),
  bytes: blob().notNull(),
});
const addresses = defineTable("transcript_asset_addresses", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  address: text().notNull(),
  asset_name: text().notNull(),
  digest: text().notNull().references("transcript_assets", "digest"),
}, table => ({ constraints: [primaryKey([table.thread_id, table.address, table.asset_name])] }));
const histories = [content, addresses].map(table => defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.transcriptAssetContent.version, table, migration: createTable(table) })],
}));
export const transcriptAssetContent = histories[0]!.current;
export const transcriptAssetAddresses = histories[1]!.current;
export const transcriptAssetContentSchemaHistory = defineSubsystemHistory(histories);
