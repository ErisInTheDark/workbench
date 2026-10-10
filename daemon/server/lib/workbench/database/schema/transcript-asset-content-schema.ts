/*
 * Exports:
 * - transcriptAssetContent: daemon-only immutable image bytes.
 * - transcriptAssetAddresses: thread-owned compatibility image addresses.
 * - transcriptAssetContentSchemaHistory: asset content installation history.
 */
import { blob, defineTable, evolveTable, index, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createIndexes, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
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
const indexedAddresses = evolveTable(addresses, {
  extras: table => ({
    constraints: [primaryKey([table.thread_id, table.address, table.asset_name])],
    indexes: [index("transcript_asset_addresses_digest_idx", [table.digest])],
  }),
});
const histories = [
  defineTableHistory({
    current: content,
    versions: [tableVersion({
      schemaVersion: releases.transcriptAssetContent.version, table: content, migration: createTable(content),
    })],
  }),
  defineTableHistory({
    current: indexedAddresses,
    versions: [
      tableVersion({
        schemaVersion: releases.transcriptAssetContent.version, table: addresses, migration: createTable(addresses),
      }),
      tableVersion({
        schemaVersion: releases.boundedPayloadRetention.version,
        table: indexedAddresses,
        migration: createIndexes({
          from: addresses, to: indexedAddresses, names: ["transcript_asset_addresses_digest_idx"],
        }),
      }),
    ],
  }),
];
export const transcriptAssetContent = histories[0]!.current;
export const transcriptAssetAddresses = histories[1]!.current;
export const transcriptAssetContentSchemaHistory = defineSubsystemHistory(histories);
