/*
 * Keywords: identity, UUID, permanent aliases, transcript, schema.
 * Exports:
 * - transcriptIdentityTables: thread, turn and item identity relations independent of transcript bodies.
 * - retiredTranscriptIdentityTables: historical identity relations retained only for migrations.
 * - TranscriptIdentitySchemaRows: current identity storage rows.
 * - transcriptIdentitySchemaHistory: identity table creation history.
 */
import databaseReleases from "./releases.ts";
import {
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  index,
  integer,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "../../../database/schema/schema-definition.ts";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  rebuildTable,
  retireTableHistory,
  tableVersion,
} from "../../../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: databaseReleases.transcriptIdentity.version, table, migration: createTable(table) })],
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

const itemSourceAliasesV1 = defineTable("workbench_transcript_item_source_aliases", {
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
}));
const itemSourceAliasesV2 = evolveTable(itemSourceAliasesV1, {
  drop: ["source_id"],
  add: {
    id: integer().primaryKey({ autoincrement: true }),
    reference: text().notNull(),
    component_kind: enumText("item", "text", "reasoning").notNull().default("item"),
    component_index: integer().notNull().nonNegative().default(0),
  },
  extras: (table) => ({
    constraints: [
      unique([
        table.turn_id,
        table.source_kind,
        table.reference,
        table.component_kind,
        table.component_index,
      ]),
      foreignKey([table.turn_id, table.thread_id], {
        table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
      }),
      foreignKey([table.item_identity_id, table.thread_id], {
        table: "workbench_transcript_item_identities", columns: ["id", "thread_id"], onDelete: "CASCADE",
      }),
    ],
    indexes: [
      index("workbench_transcript_item_source_owner_idx", [table.item_identity_id]),
      index("workbench_transcript_item_source_lookup_idx", [
        table.thread_id,
        table.source_kind,
        table.reference,
        table.component_kind,
        table.component_index,
      ]),
    ],
  }),
});
const itemSourceAliasesHistory = defineTableHistory({
  current: itemSourceAliasesV2,
  versions: [
    tableVersion({
      schemaVersion: databaseReleases.transcriptIdentity.version,
      table: itemSourceAliasesV1,
      migration: createTable(itemSourceAliasesV1),
    }),
    tableVersion({
      schemaVersion: databaseReleases.relationalTranscriptSources.version,
      table: itemSourceAliasesV2,
      migration: rebuildTable({
        from: itemSourceAliasesV1,
        to: itemSourceAliasesV2,
        map: ({ from }) => ({ reference: sql.text`${from.source_id}` }),
      }),
    }),
  ],
});

const itemLegacyAliases = defineTable("workbench_transcript_item_legacy_aliases", {
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
}));
const itemLegacyAliasesHistory = retireTableHistory(
  initialHistory(itemLegacyAliases),
  databaseReleases.relationalTranscriptSources.version,
);

export const transcriptIdentityTables = Object.freeze({
  threadLegacyAliases: threadLegacyAliasesHistory.current,
  turnLegacyAliases: turnLegacyAliasesHistory.current,
  itemIdentities: itemIdentitiesHistory.current,
  itemSourceAliases: itemSourceAliasesHistory.current,
});

export const retiredTranscriptIdentityTables = Object.freeze({ itemLegacyAliases });

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
