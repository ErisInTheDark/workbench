/*
 * Keywords: identity, UUID, permanent aliases, transcript, schema.
 * Exports:
 * - transcriptIdentityTables: thread, turn and item identity relations independent of transcript bodies.
 * - TranscriptIdentitySchemaRows: current identity storage rows.
 * - transcriptIdentitySchemaHistory: identity table creation history.
 */
import {
  defineTable,
  enumText,
  foreignKey,
  index,
  primaryKey,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "../../../database/schema/schema-definition.ts";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "../../../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: 18, table, migration: createTable(table) })],
    current: table,
  });
}

const threadLegacyAliasesHistory = initialHistory(defineTable("workbench_thread_legacy_aliases", {
  alias: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
}));

const turnLegacyAliasesHistory = initialHistory(defineTable("workbench_turn_legacy_aliases", {
  thread_id: text().notNull(),
  alias: text().notNull(),
  turn_id: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.thread_id, table.alias]),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
  ],
})));

const itemIdentitiesHistory = initialHistory(defineTable("workbench_transcript_item_identities", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [unique([table.id, table.thread_id])],
  indexes: [index("workbench_transcript_item_identity_thread_idx", [table.thread_id])],
})));

const itemSourceAliasesHistory = initialHistory(defineTable("workbench_transcript_item_source_aliases", {
  turn_id: text().notNull(),
  source_kind: enumText("stable", "provisional", "client").notNull(),
  source_id: text().notNull(),
  thread_id: text().notNull(),
  item_identity_id: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.turn_id, table.source_kind, table.source_id]),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
    foreignKey([table.item_identity_id, table.thread_id], {
      table: "workbench_transcript_item_identities", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
  ],
  indexes: [
    index("workbench_transcript_item_source_owner_idx", [table.item_identity_id]),
    index("workbench_transcript_item_source_lookup_idx", [table.thread_id, table.source_kind, table.source_id]),
  ],
})));

const itemLegacyAliasesHistory = initialHistory(defineTable("workbench_transcript_item_legacy_aliases", {
  thread_id: text().notNull(),
  turn_id: text().notNull(),
  alias: text().notNull(),
  item_identity_id: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.thread_id, table.turn_id, table.alias]),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
    foreignKey([table.item_identity_id, table.thread_id], {
      table: "workbench_transcript_item_identities", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
  ],
  indexes: [index("workbench_transcript_item_legacy_owner_idx", [table.item_identity_id])],
})));

export const transcriptIdentityTables = Object.freeze({
  threadLegacyAliases: threadLegacyAliasesHistory.current,
  turnLegacyAliases: turnLegacyAliasesHistory.current,
  itemIdentities: itemIdentitiesHistory.current,
  itemSourceAliases: itemSourceAliasesHistory.current,
  itemLegacyAliases: itemLegacyAliasesHistory.current,
});

export type TranscriptIdentitySchemaRows = {
  [Name in keyof typeof transcriptIdentityTables]: SelectRow<(typeof transcriptIdentityTables)[Name]>;
};

export const transcriptIdentitySchemaHistory = defineSubsystemHistory([
  threadLegacyAliasesHistory,
  turnLegacyAliasesHistory,
  itemIdentitiesHistory,
  itemSourceAliasesHistory,
  itemLegacyAliasesHistory,
]);
