/*
 * Exports:
 * - threadItems: canonical thread item roots.
 * - threadItemUserMessages/threadUserMessageParts: user-message storage.
 * - threadItemAssistantMessages: assistant-message storage.
 * - threadItemReasoning/threadReasoningSections: reasoning storage.
 * - threadItemFileChanges/threadFileChanges/threadFileChangeHunks/threadFileChangeCandidates: file-change storage.
 * - threadItemContextCompactions/threadItemUnknown: compaction and opaque item storage.
 * - threadItemToolOutputs/threadToolOutputParts: tool-output storage.
 * - threadItemTimelines/threadItemTimelineAliases: item timing storage.
 * - itemTables/ItemSchemaRows: current item inventory and row types.
 * - itemSchemaHistory: item schema release history.
 */
import databaseReleases from "./releases.ts";
import {
  check,
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  index,
  integer,
  jsonText,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
  tableColumns,
} from "../../../database/schema/schema-definition.ts";
import {
  addColumns,
  createTable,
  deleteRows,
  defineSubsystemHistory,
  defineTableHistory,
  rebuildTable,
  retireTableHistory,
  tableVersion,
} from "../../../database/schema/schema-history.ts";
import { evidenceTables } from "./evidence-schema.ts";
import { transcriptIdentityTables } from "./transcript-identity-schema.ts";

function initialHistory<Table extends TableDefinition>(table: Table, schemaVersion: number = databaseReleases.initialTranscript.version) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
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
const threadItemsV2 = evolveTable(threadItemsV1, {
  drop: ["type"],
  add: { type: enumText(
    "userMessage", "assistantMessage", "plan", "reasoning", "operation", "fileChange",
    "webSearch", "questionnaire", "approval", "contextCompaction", "unknown", "functionCallOutput",
  ).notNull() },
});
const threadItemsV3 = evolveTable(threadItemsV2, {
  add: { public_id: text() },
  extras: (table) => ({
    constraints: [
      unique([table.public_id]),
      unique([table.turn_id, table.item_position]),
      unique([table.id, table.type]),
      unique([table.id, table.thread_id, table.type]),
      unique([table.id, table.thread_id, table.turn_id]),
      foreignKey([table.turn_id, table.thread_id], {
        table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
      }),
      foreignKey([table.public_id, table.thread_id], {
        table: "workbench_transcript_item_identities", columns: ["id", "thread_id"], onDelete: "CASCADE",
      }),
    ],
    indexes: [
      index("thread_items_legacy_source_idx", [table.thread_id, table.source_id], {
        unique: true, where: sql`${table.public_id} IS NULL`,
      }),
      index("thread_items_source_idx", [table.thread_id, table.source_id]),
    ],
  }),
});
const threadItemsV4 = evolveTable(threadItemsV3, {
  drop: ["type"],
  add: { type: enumText(
    "userMessage", "assistantMessage", "reasoning", "operation", "fileChange",
    "webSearch", "questionnaire", "approval", "contextCompaction", "unknown", "functionCallOutput",
  ).notNull() },
});
const threadItemsHistory = defineTableHistory({
  current: threadItemsV4,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadItemsV1, migration: createTable(threadItemsV1) }),
    tableVersion({ schemaVersion: databaseReleases.toolOutputParts.version, table: threadItemsV2, migration: rebuildTable({ from: threadItemsV1, to: threadItemsV2 }) }),
    tableVersion({ schemaVersion: databaseReleases.userInputKinds.version, table: threadItemsV3, migration: rebuildTable({ from: threadItemsV2, to: threadItemsV3 }) }),
    tableVersion({
      schemaVersion: databaseReleases.nativePlanRemoval.version,
      table: threadItemsV4,
      migration: [
        deleteRows(
          transcriptIdentityTables.itemSourceAliases.name,
          sql`${tableColumns(transcriptIdentityTables.itemSourceAliases).item_identity_id} IN (
            SELECT public_id FROM thread_items WHERE type = 'plan' AND public_id IS NOT NULL
          )`,
        ),
        deleteRows(
          transcriptIdentityTables.itemLegacyAliases.name,
          sql`${tableColumns(transcriptIdentityTables.itemLegacyAliases).item_identity_id} IN (
            SELECT public_id FROM thread_items WHERE type = 'plan' AND public_id IS NOT NULL
          )`,
        ),
        deleteRows(
          transcriptIdentityTables.itemIdentities.name,
          sql`${tableColumns(transcriptIdentityTables.itemIdentities).id} IN (
            SELECT public_id FROM thread_items WHERE type = 'plan' AND public_id IS NOT NULL
          )`,
        ),
        deleteRows(
          evidenceTables.transcriptNativeRecords.name,
          sql`${tableColumns(evidenceTables.transcriptNativeRecords).item_id} IN (
            SELECT id FROM thread_items WHERE type = 'plan'
          )`,
        ),
        deleteRows(
          evidenceTables.transcriptAssetRefs.name,
          sql`${tableColumns(evidenceTables.transcriptAssetRefs).item_id} IN (
            SELECT id FROM thread_items WHERE type = 'plan'
          )`,
        ),
        deleteRows(
          "thread_item_timeline_aliases",
          sql`item_id IN (
            SELECT id FROM thread_items WHERE type = 'plan'
          )`,
        ),
        deleteRows(
          "thread_item_timelines",
          sql`item_id IN (
            SELECT id FROM thread_items WHERE type = 'plan'
          )`,
        ),
        deleteRows(threadItemsV3.name, sql`${tableColumns(threadItemsV3).type} = ${literal("plan")}`),
        rebuildTable({ from: threadItemsV3, to: threadItemsV4 }),
      ],
    }),
  ],
});
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
const threadItemUserMessagesV2 = evolveTable(threadItemUserMessagesV1, {
  add: { input_kind: enumText("initial", "steer").notNull().default("initial") },
});
const threadItemUserMessagesHistory = defineTableHistory({
  current: threadItemUserMessagesV2,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadItemUserMessagesV1, migration: createTable(threadItemUserMessagesV1) }),
    tableVersion({
      schemaVersion: databaseReleases.userInputKinds.version,
      table: threadItemUserMessagesV2,
      migration: addColumns({ from: threadItemUserMessagesV1, to: threadItemUserMessagesV2, columns: ["input_kind"] }),
    }),
  ],
});
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
const threadItemPlansHistory = retireTableHistory(
  initialHistory(threadItemPlansV1),
  databaseReleases.nativePlanRemoval.version,
);

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
const threadItemFileChangesV2 = evolveTable(threadItemFileChangesV1, {
  add: {
    workbench_policy: enumText("automaticEscalation"),
    recovery_state: enumText("queued", "failed"),
    recovery_detail: text(),
  },
});
const threadItemFileChangesHistory = defineTableHistory({
  current: threadItemFileChangesV2,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadItemFileChangesV1, migration: createTable(threadItemFileChangesV1) }),
    tableVersion({ schemaVersion: databaseReleases.fileChangeDetails.version, table: threadItemFileChangesV2, migration: addColumns({
      from: threadItemFileChangesV1, to: threadItemFileChangesV2, columns: ["workbench_policy", "recovery_state", "recovery_detail"],
    }) }),
  ],
});
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
const threadFileChangesV2 = evolveTable(threadFileChangesV1, {
  add: {
    analysis_outcome: enumText("present", "unapplied", "partial", "copied", "uncertain"),
    analysis_detail: text(),
    analysis_additions: integer().nonNegative(),
    analysis_deletions: integer().nonNegative(),
  },
});
const threadFileChangesHistory = defineTableHistory({
  current: threadFileChangesV2,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.initialTranscript.version, table: threadFileChangesV1, migration: createTable(threadFileChangesV1) }),
    tableVersion({ schemaVersion: databaseReleases.fileChangeDetails.version, table: threadFileChangesV2, migration: addColumns({
      from: threadFileChangesV1, to: threadFileChangesV2, columns: ["analysis_outcome", "analysis_detail", "analysis_additions", "analysis_deletions"],
    }) }),
  ],
});
export const threadFileChanges = threadFileChangesHistory.current;

const threadFileChangeHunksV1 = defineTable("thread_file_change_hunks", {
  item_id: integer().notNull(),
  change_index: integer().notNull().nonNegative(),
  hunk_index: integer().notNull().nonNegative(),
  outcome: enumText("present", "unapplied", "uncertain").notNull(),
  reason: text(),
  additions: integer().notNull().nonNegative(),
  deletions: integer().notNull().nonNegative(),
  current_start: integer().nonNegative(),
  current_end: integer().nonNegative(),
  old_start: integer().nonNegative(),
  new_start: integer().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.change_index, table.hunk_index]),
    foreignKey([table.item_id, table.change_index], { table: "thread_file_changes", columns: ["item_id", "change_index"], onDelete: "CASCADE" }),
  ],
}));
const threadFileChangeHunksHistory = initialHistory(threadFileChangeHunksV1, databaseReleases.fileChangeDetails.version);
export const threadFileChangeHunks = threadFileChangeHunksHistory.current;

const threadFileChangeCandidatesV1 = defineTable("thread_file_change_candidates", {
  item_id: integer().notNull(),
  change_index: integer().notNull().nonNegative(),
  hunk_index: integer().notNull().nonNegative(),
  candidate_index: integer().notNull().nonNegative(),
  current_line: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.change_index, table.hunk_index, table.candidate_index]),
    foreignKey([table.item_id, table.change_index, table.hunk_index], {
      table: "thread_file_change_hunks", columns: ["item_id", "change_index", "hunk_index"], onDelete: "CASCADE",
    }),
  ],
}));
const threadFileChangeCandidatesHistory = initialHistory(threadFileChangeCandidatesV1, databaseReleases.fileChangeDetails.version);
export const threadFileChangeCandidates = threadFileChangeCandidatesHistory.current;

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

const threadItemToolOutputsV1 = defineTable("thread_item_tool_outputs", {
  item_id: integer().primaryKey(),
  item_type: enumText("functionCallOutput").notNull().default("functionCallOutput"),
  name: text().notNull(),
  namespace: text(),
  body_kind: enumText("text", "parts").notNull(),
  body_text: text(),
  injection_accepted_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    foreignKey([table.item_id, table.item_type], { table: "thread_items", columns: ["id", "type"], onDelete: "CASCADE" }),
    check(sql`
      (${table.body_kind} = ${literal("text")} AND ${table.body_text} IS NOT NULL)
      OR (${table.body_kind} = ${literal("parts")} AND ${table.body_text} IS NULL)
    `),
  ],
}));
const threadItemToolOutputsHistory = initialHistory(threadItemToolOutputsV1, databaseReleases.toolOutputParts.version);
export const threadItemToolOutputs = threadItemToolOutputsHistory.current;

const threadToolOutputPartsV1 = defineTable("thread_tool_output_parts", {
  item_id: integer().notNull().references("thread_item_tool_outputs", "item_id", { onDelete: "CASCADE" }),
  part_index: integer().notNull().nonNegative(),
  part_type: enumText("text", "image").notNull(),
  text: text(),
  image_url: text(),
  image_detail: enumText("auto", "low", "high", "original"),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.part_index]),
    check(sql`
      (${table.part_type} = ${literal("text")} AND ${table.text} IS NOT NULL AND ${table.image_url} IS NULL AND ${table.image_detail} IS NULL)
      OR (${table.part_type} = ${literal("image")} AND ${table.text} IS NULL AND ${table.image_url} IS NOT NULL)
    `),
  ],
}));
const threadToolOutputPartsHistory = initialHistory(threadToolOutputPartsV1, databaseReleases.toolOutputParts.version);
export const threadToolOutputParts = threadToolOutputPartsHistory.current;

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
  threadItemReasoning,
  threadReasoningSections,
  threadItemFileChanges,
  threadFileChanges,
  threadFileChangeHunks,
  threadFileChangeCandidates,
  threadItemContextCompactions,
  threadItemUnknown,
  threadItemToolOutputs,
  threadToolOutputParts,
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
  threadFileChangeHunksHistory,
  threadFileChangeCandidatesHistory,
  threadItemContextCompactionsHistory,
  threadItemUnknownHistory,
  threadItemToolOutputsHistory,
  threadToolOutputPartsHistory,
]);
